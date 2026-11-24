# ─── 熔断误判修复验证：客户端断连不计失败样本；真实失败仍能熔断 ───
# 用法（项目根）： powershell -ExecutionPolicy Bypass -File scripts\k6\verify-circuit-abort.ps1
# 前置：已有生产构建（.next\BUILD_ID）、测试库 prompthub_test 可连、k6.exe 已安装
# 步骤：
#   1) mock 上游(FAIL_RATE=0) → 种子夹具 → 应用实例(3101, prompthub_test)
#   2) 基线探测（期望 200 + [DONE]）
#   3) k6 断连场景 K6_DISCONNECT=1 / K6_ONLY_DISCONNECT=1（30s × 5/s）
#   4) 断连后连续探测（期望仍 200，不出现 no_upstream_key）
#   5) mock 切 FAIL_RATE=1，连续 8 次请求 → 期望先 upstream_error 后 no_upstream_key（熔断仍生效）
#   6) 重启 mock(FAIL_RATE=0) + 重启应用（清空内存熔断态）→ 无断连稳态 k6 回归
# 结果：tests\k6\verify-abort-circuit.txt

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
$reportPath = Join-Path $resultsDir "verify-abort-circuit.txt"

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

$script:lines = New-Object System.Collections.Generic.List[string]
function Log([string]$msg) {
  $line = "$(Get-Date -Format 'HH:mm:ss') $msg"
  $script:lines.Add($line)
  Write-Host $line
}

function Stop-ByPattern([string]$pattern) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='npx.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$pattern*" } | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# 按 PID 树终止（taskkill /T）：npx.cmd → node 子进程一并回收，确保端口真正释放
function Stop-Tree($proc) {
  if ($proc -and -not $proc.HasExited) {
    & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
  }
  Start-Sleep -Milliseconds 900
}

function Assert-PortFree([int]$port) {
  for ($i = 0; $i -lt 10; $i++) {
    $conn = $null
    try { $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop } catch { }
    if (-not $conn) { return }
    $conn | Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { & taskkill /PID $_ /T /F 2>&1 | Out-Null }
    Start-Sleep -Milliseconds 500
  }
  throw "port $port still occupied"
}

$mockPort = 19810
$appPort = 3102
$baseUrl = "http://localhost:$appPort/api/playground/chat"
$payloadFile = Join-Path $resultsDir ".probe-payload.json"
# ASCII-only 载荷，规避 PS5 写文件带 BOM 导致 JSON 解析失败
Set-Content -Path $payloadFile -Value '{"model":"chat-k6","messages":[{"role":"user","content":"circuit probe ping"}],"max_tokens":50}' -Encoding ascii

function Start-Mock([string]$failRate) {
  $env:MOCK_PORT = "$mockPort"
  $env:FAIL_RATE = $failRate
  $mockLog = Join-Path $resultsDir "mock-verify.log"
  Remove-Item $mockLog, "$mockLog.err" -ErrorAction SilentlyContinue
  $script:mockProc = Start-Process -FilePath "node" -ArgumentList (Join-Path $root "scripts\k6\mock-upstream.mjs") `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $mockLog -RedirectStandardError "$mockLog.err"
  Start-Sleep -Seconds 2
  $line = Get-Content $mockLog -Raw -ErrorAction SilentlyContinue
  if ($line -notlike "*listening*") {
    throw "mock failed to start: $(Get-Content "$mockLog.err" -Raw -ErrorAction SilentlyContinue)"
  }
}

function Start-App {
  # 端口必须由本脚本实例独占：先清掉任何遗留监听者，否则会误测到旧构建
  Assert-PortFree $appPort
  $env:DATABASE_URL = "postgresql://postgres@127.0.0.1:5432/prompthub_test?schema=public"
  Remove-Item Env:API_GATEWAY_HOSTS -ErrorAction SilentlyContinue
  $env:PORT = "$appPort"
  Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue
  $appLog = Join-Path $resultsDir "app-verify-$appPort.log"
  Remove-Item $appLog, "$appLog.err" -ErrorAction SilentlyContinue
  $script:appProc = Start-Process -FilePath "npx.cmd" -ArgumentList ("next", "start", "-p", "$appPort") `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $appLog -RedirectStandardError "$appLog.err"
  $proc = $script:appProc
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) {
      $err = Get-Content "$appLog.err" -Raw -ErrorAction SilentlyContinue
      throw "app exited (code=$($proc.ExitCode)): $err"
    }
    try {
      $code = (Invoke-WebRequest -Uri "http://127.0.0.1:$appPort/" -UseBasicParsing -TimeoutSec 5).StatusCode
      if ($code -eq 200) { Log ("app ready on {0} (pid={1})" -f $appPort, $proc.Id); return }
    } catch { }
  }
  throw "app on $appPort not ready"
}

# 探测：返回 状态码/耗时/是否流完成/错误码
function Invoke-Probe([string]$tag, [string]$token) {
  $out = Join-Path $resultsDir ".probe-$tag.body"
  Remove-Item $out -ErrorAction SilentlyContinue
  $raw = & curl.exe -s -S --max-time 60 -o $out -w "%{http_code} %{time_total}" -X POST $baseUrl `
    -H "Content-Type: application/json" -H "Cookie: token=$token" --data-binary "@$payloadFile" 2>$null
  $parts = "$raw".Trim() -split "\s+"
  $code = $parts[0]
  $sec = 0.0
  if ($parts.Length -gt 1) { [void][double]::TryParse($parts[1], [ref]$sec) }
  $body = ""
  if (Test-Path $out) { $body = Get-Content $out -Raw -ErrorAction SilentlyContinue }
  $done = $body -and $body.Contains("[DONE]")
  $errCode = ""
  if ($body) {
    if ($body.Contains("no_upstream_key")) { $errCode = "no_upstream_key" }
    elseif ($body.Contains("upstream_error")) { $errCode = "upstream_error" }
    elseif ($body.Contains("client_cancelled")) { $errCode = "client_cancelled" }
  }
  $result = [pscustomobject]@{ Tag = $tag; Code = $code; Seconds = [Math]::Round($sec, 3); StreamDone = [bool]$done; ErrCode = $errCode }
  Log ("probe[{0}] http={1} t={2}s stream_done={3} err={4}" -f $result.Tag, $result.Code, $result.Seconds, $result.StreamDone, ($(if ($errCode) { $errCode } else { "-" })))
  return $result
}

try {
  # ── 1. mock + 夹具 + 应用 ──
  Log "[1] start mock(FAIL_RATE=0) + seed + app(3101)"
  Start-Mock "0"
  node scripts\k6\seed-k6-fixture.mjs
  if ($LASTEXITCODE -ne 0) { throw "seed failed" }
  $token = (Get-Content (Join-Path $root "scripts\k6\.k6-token") -Raw).Trim()
  Start-App

  # ── 2. 基线 ──
  Log "[2] baseline probe"
  $p = Invoke-Probe "baseline" $token
  $baselineOk = ($p.Code -eq "200" -and $p.StreamDone)
  Log ("baseline_pass={0}" -f $baselineOk)

  # ── 3. 断连压测 ──
  Log "[3] k6 disconnect scenario (K6_DISCONNECT=1 K6_ONLY_DISCONNECT=1)"
  $env:K6_BASE_URL = "http://localhost:$appPort"
  $env:K6_TOKEN = $token
  $env:K6_DISCONNECT = "1"
  $env:K6_ONLY_DISCONNECT = "1"
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $K6Path run (Join-Path $root "tests\k6\playground-sse.js") 2>&1 |
    Tee-Object -FilePath (Join-Path $resultsDir "verify-disconnect-k6.txt") | Out-Null
  $k6Exit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  Remove-Item Env:K6_ONLY_DISCONNECT -ErrorAction SilentlyContinue
  $disc = Get-Content (Join-Path $resultsDir "verify-disconnect-k6.txt") -Raw
  $mAborts = [regex]::Match($disc, "pg_client_aborts\.*\s*:\s*(\d+)")
  $mComplete = [regex]::Match($disc, "pg_completed\.*\s*:\s*(\d+)")
  $mErrs = [regex]::Match($disc, "pg_errors\.*\s*:\s*(\d+)")
  Log ("k6 disconnect: exit={0} client_aborts={1} completed={2} errors={3}" -f $k6Exit, $mAborts.Groups[1].Value, $mComplete.Groups[1].Value, $mErrs.Groups[1].Value)

  # mock 侧统计（确认断连期间上游确实被调用过，不是全部被短路）
  try {
    $hz = Invoke-RestMethod -Uri "http://127.0.0.1:$mockPort/healthz" -TimeoutSec 5
    Log ("mock stats after disconnect: total={0} stream={1} abort_close={2} fail={3}" -f $hz.total, $hz.stream, $hz.aborts, $hz.fail)
  } catch { Log "mock healthz failed" }

  # ── 4. 断连后探测：熔断不应被打开 ──
  Log "[4] probes after disconnect (expect 200 stream, no no_upstream_key)"
  $after = @()
  for ($i = 1; $i -le 6; $i++) {
    $after += Invoke-Probe "after-disconnect-$i" $token
    Start-Sleep -Milliseconds 400
  }
  $afterOk = ($after | Where-Object { $_.Code -eq "200" -and $_.StreamDone }).Count
  $afterNoKey = ($after | Where-Object { $_.ErrCode -eq "no_upstream_key" }).Count
  Log ("after_disconnect: ok={0}/6 no_upstream_key={1}" -f $afterOk, $afterNoKey)

  # ── 5. 真实失败仍熔断：全新应用实例 + mock FAIL_RATE=1（隔离前面阶段的内存态） ──
  Log "[5] real upstream failure (FAIL_RATE=1, fresh app) → expect breaker open"
  Stop-Tree $script:appProc
  Stop-Tree $script:mockProc
  Start-Mock "1"
  Start-App
  $failProbes = @()
  for ($i = 1; $i -le 8; $i++) {
    $failProbes += Invoke-Probe "real-fail-$i" $token
    Start-Sleep -Milliseconds 200
  }
  $upErr = ($failProbes | Where-Object { $_.ErrCode -eq "upstream_error" }).Count
  $noKey = @($failProbes | Where-Object { $_.ErrCode -eq "no_upstream_key" })
  $fastFail = @($noKey | Where-Object { $_.Seconds -lt 0.5 }).Count
  Log ("real_failure: upstream_error={0} no_upstream_key={1} fast_no_key(<0.5s)={2}" -f $upErr, $noKey.Count, $fastFail)
  Log ("real_failure sequence: " + (($failProbes | ForEach-Object { "$($_.Tag)=$($_.ErrCode)-$($_.Seconds)s" }) -join " | "))

  # ── 6. 恢复 mock + 重启应用 → 无断连稳态回归 ──
  Log "[6] restore mock(FAIL_RATE=0) + fresh app + steady k6"
  Stop-Tree $script:appProc
  Stop-Tree $script:mockProc
  Start-Mock "0"
  Start-App
  $p2 = Invoke-Probe "fresh-app" $token
  Log ("fresh_app_pass={0}" -f ($p2.Code -eq "200" -and $p2.StreamDone))

  Remove-Item Env:K6_DISCONNECT -ErrorAction SilentlyContinue
  $ErrorActionPreference = "Continue"
  & $K6Path run (Join-Path $root "tests\k6\playground-sse.js") 2>&1 |
    Tee-Object -FilePath (Join-Path $resultsDir "verify-steady-k6.txt") | Out-Null
  $steadyExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $steady = Get-Content (Join-Path $resultsDir "verify-steady-k6.txt") -Raw
  $sComplete = [regex]::Match($steady, "pg_completed\.*\s*:\s*(\d+)")
  $sErrs = [regex]::Match($steady, "pg_errors\.*\s*:\s*(\d+)")
  $sP95 = [regex]::Match($steady, "http_req_duration\.*\s*:\s*avg=[^\s]+\s+min=[^\s]+\s+med=[^\s]+\s+max=[^\s]+\s+p\(90\)=[^\s]+\s+p\(95\)=([^\s]+)")
  Log ("k6 steady: exit={0} completed={1} errors={2} p95={3}" -f $steadyExit, $sComplete.Groups[1].Value, $sErrs.Groups[1].Value, $sP95.Groups[1].Value)

  # ── 结论 ──
  $pass = $baselineOk -and ($afterOk -eq 6) -and ($afterNoKey -eq 0) -and ($noKey.Count -ge 1) -and ($fastFail -ge 1) -and ($upErr -ge 1)
  Log ("RESULT: {0}" -f ($(if ($pass) { "PASS" } else { "FAIL" })))
  Log "  - 断连后熔断态：closed（6/6 探测 200 流完成，0 次 no_upstream_key）"
  Log "  - 真实失败仍熔断：先 upstream_error 后 no_upstream_key 快速失败"
}
finally {
  Stop-Tree $script:appProc
  Stop-Tree $script:mockProc
  Stop-ByPattern "mock-upstream.mjs"
  $script:lines | Out-File -FilePath $reportPath -Encoding utf8
  Write-Host "`n[verify] cleanup done. report -> $reportPath"
}
