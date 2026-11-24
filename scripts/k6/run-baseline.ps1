# ─── P6 #20 k6 压测基线编排（本地运行，测试库 prompthub_test，与开发/生产隔离）───
# 用法: powershell -ExecutionPolicy Bypass -File scripts\k6\run-baseline.ps1 [-K6Path <k6.exe>]
# 流程：启动 mock 上游（FAIL_RATE=0）→ 种子夹具 → 启动应用实例(3101, 测试库, 网关白名单=127.0.0.1)
#   → k6 SSE 基线（阶梯 10/30/50 VU + 断连场景）→ 重启 mock（FAIL_RATE=0.3）→ k6 故障注入
#   → 清理进程。结果输出 tests\k6\results-steady.txt / results-fault.txt

param(
  [string]$K6Path = ""
)
$ErrorActionPreference = "Stop"
# 工具包装执行会丢失 $PSScriptRoot/$MyInvocation 脚本上下文，改用 cwd 锚定（调用方需在项目根运行）
$root = (Get-Location).Path
if (-not (Test-Path (Join-Path $root "package.json"))) {
  throw "请在项目根目录运行本脚本（当前目录：$root）"
}
$resultsDir = Join-Path $root "tests\k6"
New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null

# ── 定位 k6 ──
if (-not $K6Path) {
  $k6Dir = Join-Path $env:LOCALAPPDATA "k6"
  if (Test-Path $k6Dir) {
    $found = Get-ChildItem $k6Dir -Recurse -Filter "k6.exe" | Select-Object -First 1
    if ($found) { $K6Path = $found.FullName }
  }
  if (-not $K6Path) {
    $cmd = Get-Command k6 -ErrorAction SilentlyContinue
    if ($cmd) { $K6Path = $cmd.Source }
  }
}
if (-not $K6Path -or -not (Test-Path $K6Path)) {
  Write-Error "k6.exe 未找到：请先安装 k6 或用 -K6Path 指定"
}
Write-Host "[runner] k6 = $K6Path"

# ── 进程清理工具：按命令行匹配（连带子进程）──
function Stop-ByPattern([string]$pattern) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$pattern*" } | ForEach-Object {
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$($_.ProcessId)" | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$mockPort = 19810
$env:MOCK_PORT = "$mockPort"
$env:FAIL_RATE = "0"

try {
  # ── 1. 启动 mock 上游（无故障）──
  $mockLog = Join-Path $resultsDir "mock-steady.log"
  Start-Process -FilePath "node" -ArgumentList (Join-Path $root "scripts\k6\mock-upstream.mjs") `
    -WindowStyle Hidden -RedirectStandardOutput $mockLog -RedirectStandardError "$mockLog.err"
  Start-Sleep -Seconds 2
  Write-Host "[runner] mock up (FAIL_RATE=0) on :$mockPort"

  # ── 2. 种子夹具（prompthub_test）──
  Push-Location $root
  node scripts\k6\seed-k6-fixture.mjs
  if ($LASTEXITCODE -ne 0) { throw "seed failed" }
  $token = (Get-Content (Join-Path $root "scripts\k6\.k6-token") -Raw).Trim()
  Pop-Location

  # ── 3. 启动应用实例（3101，测试库，白名单 127.0.0.1）──
  $env:DATABASE_URL = "postgresql://postgres@127.0.0.1:5432/prompthub_test?schema=public"
  $env:API_GATEWAY_HOSTS = "127.0.0.1,localhost"
  Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue   # k6 场景走 inline，不掺队列变量
  $appLog = Join-Path $resultsDir "app-3101.log"
  Start-Process -FilePath "npx.cmd" -ArgumentList "next", "start", "-p", "3101" `
    -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $appLog -RedirectStandardError "$appLog.err"
  Pop-Location
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $code = (Invoke-WebRequest -Uri "http://127.0.0.1:3101/" -UseBasicParsing -TimeoutSec 5).StatusCode
      if ($code -eq 200) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw "app on 3101 not ready" }
  Write-Host "[runner] app up on :3101 (prompthub_test, gateway-host=127.0.0.1)"

  $env:K6_BASE_URL = "http://127.0.0.1:3101"
  $env:K6_TOKEN = $token

  # ── 4. k6 SSE 基线（含断连场景）──
  Write-Host "`n[runner] ===== k6 SSE baseline (steady + disconnect) ====="
  & $K6Path run (Join-Path $root "tests\k6\sse-baseline.js") 2>&1 | Tee-Object -FilePath (Join-Path $resultsDir "results-steady.txt")

  # ── 5. 重启 mock：FAIL_RATE=0.3 → 故障注入 ──
  Stop-ByPattern "mock-upstream.mjs"
  $env:FAIL_RATE = "0.3"
  $mockLog2 = Join-Path $resultsDir "mock-fault.log"
  Start-Process -FilePath "node" -ArgumentList (Join-Path $root "scripts\k6\mock-upstream.mjs") `
    -WindowStyle Hidden -RedirectStandardOutput $mockLog2 -RedirectStandardError "$mockLog2.err"
  Start-Sleep -Seconds 2
  Write-Host "`n[runner] ===== k6 fault injection (upstream 502 x30%) ====="
  & $K6Path run (Join-Path $root "tests\k6\fault-injection.js") 2>&1 | Tee-Object -FilePath (Join-Path $resultsDir "results-fault.txt")
}
finally {
  # ── 6. 清理 ──
  Stop-ByPattern "mock-upstream.mjs"
  Stop-ByPattern "next start -p 3101"
  Write-Host "`n[runner] cleanup done. results -> tests\k6\results-*.txt"
}
