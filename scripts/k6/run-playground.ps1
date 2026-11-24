# ─── 冰山实验场 M4：/api/playground/chat 压测编排（本地，测试库 prompthub_test）───
# 前置：先有生产构建（项目根 `npx next build`）。本脚本不自建，避免边构建边服务。
# 用法：在项目根运行  powershell -ExecutionPolicy Bypass -File scripts\k6\run-playground.ps1
# 流程：mock 上游(FAIL_RATE=0) → 种子夹具 → 应用实例(3101, prompthub_test) → k6 → 清理
# 结果：tests\k6\results-playground.txt

param(
  [string]$K6Path = ""
)
$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
if (-not (Test-Path (Join-Path $root "package.json"))) {
  throw "请在项目根目录运行本脚本（当前目录：$root）"
}
if (-not (Test-Path (Join-Path $root ".next\BUILD_ID"))) {
  throw "未找到生产构建产物（.next\BUILD_ID），请先在项目根执行 npx next build"
}
$resultsDir = Join-Path $root "tests\k6"
New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null

if (-not $K6Path) {
  $k6Dir = Join-Path $env:LOCALAPPDATA "k6"
  if (Test-Path $k6Dir) {
    $found = Get-ChildItem $k6Dir -Recurse -Filter "k6.exe" | Select-Object -First 1
    if ($found) { $K6Path = $found.FullName }
  }
}
if (-not $K6Path -or -not (Test-Path $K6Path)) {
  throw "k6.exe 未找到：请先安装 k6 或用 -K6Path 指定"
}

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
  # ── 1. mock 上游 ──
  $mockLog = Join-Path $resultsDir "mock-playground.log"
  Start-Process -FilePath "node" -ArgumentList (Join-Path $root "scripts\k6\mock-upstream.mjs") `
    -WindowStyle Hidden -RedirectStandardOutput $mockLog -RedirectStandardError "$mockLog.err"
  Start-Sleep -Seconds 2

  # ── 2. 种子夹具（prompthub_test，幂等）──
  node scripts\k6\seed-k6-fixture.mjs
  if ($LASTEXITCODE -ne 0) { throw "seed failed" }
  $token = (Get-Content (Join-Path $root "scripts\k6\.k6-token") -Raw).Trim()

  # ── 3. 应用实例（3101，测试库）──
  $env:DATABASE_URL = "postgresql://postgres@127.0.0.1:5432/prompthub_test?schema=public"
  # 实验场走站内页面接口，不能把 127.0.0.1 当网关域名（否则 middleware 会统一返回文档 JSON）
  Remove-Item Env:API_GATEWAY_HOSTS -ErrorAction SilentlyContinue
  $env:PORT = "3101"   # 让 middleware 的 gateway-meta 自取本实例，不落到 3000 上的旧实例
  Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue
  $appLog = Join-Path $resultsDir "app-playground-3101.log"
  Start-Process -FilePath "npx.cmd" -ArgumentList "next", "start", "-p", "3101" `
    -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $appLog -RedirectStandardError "$appLog.err"
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    try {
      $code = (Invoke-WebRequest -Uri "http://127.0.0.1:3101/" -UseBasicParsing -TimeoutSec 5).StatusCode
      if ($code -eq 200) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw "app on 3101 not ready" }

  # ── 4. k6 ──
  $env:K6_BASE_URL = "http://localhost:3101"
  $env:K6_TOKEN = $token
  # 断连场景会刻意产生 request timeout，k6 会把它们写到 stderr；
  # Stop 模式下 2>&1 会把 stderr 当成终止错误，导致编排提前中断。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $K6Path run (Join-Path $root "tests\k6\playground-sse.js") 2>&1 |
    Tee-Object -FilePath (Join-Path $resultsDir "results-playground.txt")
  $k6Exit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  Write-Host "[runner] k6 exit=$k6Exit"
}
finally {
  Stop-ByPattern "mock-upstream.mjs"
  Stop-ByPattern "next start -p 3101"
  Write-Host "`n[runner] cleanup done. results -> tests\k6\results-playground.txt"
}
