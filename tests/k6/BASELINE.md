# P6 #20 k6 压测基线（v0.113，2026-11-12）

环境：本机 Windows / Next.js 生产构建（3101 端口）/ prompthub_test 测试库 / mock 上游（scripts/k6/mock-upstream.mjs，20 chunk × 15ms SSE）
工具：k6 v2.3.0（%LOCALAPPDATA%\k6）；夹具：scripts/k6/seed-k6-fixture.mjs（k6load 用户 + chat-k6 模型 + 1000000 配额）
复跑：`powershell -File scripts\k6\run-baseline.ps1`（需 5432 测试库 + 项目根运行）

## 一、SSE 稳态基线（tests/k6/sse-baseline.js）

场景：阶梯 10→30→50 VU（80s 主负载 + 30s 断连场景串行在后）
结果：**3054 次完整流式会话，检查 100% 通过，0 裸 500**

| 指标 | avg | p90 | p95 | p99 |
|---|---|---|---|---|
| 首 token 延迟 sse_first_token_ms | 44 ms | 94 ms | **112 ms** | 145 ms |
| 整流时长 sse_total_ms | 433 ms | 487 ms | **507 ms** | 546 ms |
| 吞吐（会话） | — | — | ≈24.4/s | — |
| 客户端主动断连（300ms 超时切断） | 111 次被正确处理 | — | — | — |

结论：50 VU 下首 token p95 ≈ 112ms、整流 p95 ≈ 507ms，无失败会话。

## 二、故障注入基线（tests/k6/fault-injection.js，上游 30% 502）

场景：20 VU × 60s，mock 按 FAIL_RATE=0.3 随机 502
结果：**692/2415（28.65%）上游故障，全部返回规范网关 502 错误体，0 裸 500，服务不崩**

| 指标 | avg | p95 |
|---|---|---|
| 错误路径耗时（fail-fast） | 30 ms | **51 ms** |
| 正常流 p95（故障同期） | — | 465 ms |
| 成功率 | 71.34%（≈注入比例 70%） | — |

结论：上游 30% 故障时网关错误体 100% 规范、错误路径 fail-fast（p95 51ms）、可用性≈70% 与注入比例一致。

## 三、已知 finding（后续优化项）

1. **客户端中止会计入熔断失败窗口**：k6 断连场景（客户端 300ms 中止）触发的上游取消被
   recordKeyOutcome 记为失败，失败率窗口被灌满后熔断打开，期间正常请求收到 502
   （half-open 探测恢复）。建议：客户端主动断连（ECONNRESET/cancelled）不计入熔断失败样本。
2. 断连场景与稳态并发跑会互相污染统计，基线脚本已改为串行（disconnect startTime=95s）。

## 四、基线守护

后续改动如需对比回归，重跑 `run-baseline.ps1` 并与上表对比：
首 token p95 与整流 p95 恶化 >50%，或故障注入出现裸 500 / 错误体不规范 → 视为回归。

## 五、实验场站内接口基线（v2 M4，2026-11-13）

环境同上（3101 / prompthub_test / mock 上游），但目标换成站内接口 `/api/playground/chat`
（Cookie 鉴权 + 计分预扣结算 + 每轮写 `playground_session` / `playground_message`）。
复跑：`powershell -File scripts\k6\run-playground.ps1`（需先 `npx next build`）。

场景：阶梯 10→30→50 VU × 80s（默认只跑稳态；`K6_DISCONNECT=1` 才加断连场景）
结果：**3101 次完整流式会话，检查 6202/6202 通过，0 失败请求**

| 指标 | avg | p90 | p95 | p99 |
|---|---|---|---|---|
| 首 token 延迟 pg_first_token_ms | 36 ms | 69 ms | **90 ms** | 123 ms |
| 整流时长 pg_total_ms | 420 ms | 463 ms | **485 ms** | 528 ms |
| 吞吐（会话） | — | — | ≈38.4/s | — |

结论：每轮多写两张表之后，50 VU 下首 token p95 ≈ 90ms、整流 p95 ≈ 485ms，
与网关基线（112ms / 507ms）同量级且略好；本轮无 5xx、无裸错误体。

**踩坑记录**：本地压测必须用 `http://localhost:3101`。middleware 的网关域名隔离会把
`127.0.0.1` 当网关域名，非 `/v1` 路径统一返回文档 JSON（HTTP 200），压测会得到「全 200
但正文不对」的假数据。`run-playground.ps1` 已固定 localhost 口径。

## 六、实验场基线补测（2026-11-16 完成）

### 6.1 断连场景（`K6_DISCONNECT=1`）

- 复跑：`$env:K6_DISCONNECT="1"; $env:K6_ONLY_DISCONNECT="1"; powershell -File scripts\k6\run-playground.ps1`
  （只跑断连，避免与稳态串行互相污染）
- 结果：151 次请求（5/s × 30s，含边界 1 次），**11 次客户端 300ms 中止，140 次 502 `no_upstream_key`**
- 延迟：p50 21.6ms / p95 299ms / p99 300ms（≈22ms 那批是熔断后 fail-fast，299ms 是断连前的真请求）
- 结论：§三-1 的熔断误计数在站内接口复现。`MIN_SAMPLES=5` + `FAIL_RATE=0.5` → 前 11 次断连就把 Key 熔断打开；
  `OPEN_COOLDOWN_MS=60s` → 剩余 28s 全部 502。**待修：客户端主动中止不应计入熔断失败样本。**

### 6.2 技能挂载路径（`skillIds`）

- 夹具：`seed-k6-fixture.mjs` 新增 `k6-skill-material`（published + featured，素材约 3k 字，含手机号/邮箱/注入句用于验证中和）
- 压测：`$env:K6_SKILL_IDS=<id>; powershell -File scripts\k6\run-playground.ps1`（50 VU × 80s，比计划的 20 VU 更严）
- 结果：**3030 次完整会话，检查 6060/6060 通过，0 失败**；整流 p95 **497ms**（无技能 485ms，+2.5%）、avg 438ms
- 注入证据：`usage_record.promptTokens` 从基线 12–13 跳到 **459**（3030 条全部一致），素材确实拼进了上游请求
- 结论：技能素材把输入 token 放大 ≈35×，但吞吐/延迟仍在基线内，挂载路径无 5xx

### 6.3 本轮编排修复

1. `run-playground.ps1`：k6 段临时 `$ErrorActionPreference = "Continue"`。断连场景会刻意产生
   `request timeout` 到 stderr，Stop 模式 + `2>&1` 会把它当终止错误，导致编排卡死/提前中断。
2. `playground-sse.js`：新增 `K6_ONLY_DISCONNECT=1`（只跑断连，不设非零 `startTime`）。
   非零 `startTime` 与 Stop 模式组合是本轮卡死诱因，单跑断连不要设。
3. `playground-sse.js`：payload 支持 `K6_SKILL_IDS`（逗号分隔），其余口径与稳态完全一致。

## 七、熔断误判修复验证（2026-11-16 修复后）

修复要点：adapter 用「AbortError + 调用方 signal 已 abort + 自身超时 signal 未触发」三条件
判定客户端取消（`isClientAbort`），路由改调中性的 `recordKeyCancelled`（不进窗口、不改状态、
只归还半开探测名额）；真实失败仍走 `recordKeyOutcome(...false...)`。

验证脚本：`powershell -File scripts\k6\verify-circuit-abort.ps1`
（自动起 mock + 应用 3102，跑断连 → 断连后探测 → 真实失败 → 稳态回归，报告写 `tests\k6\verify-abort-circuit.txt`）

| 阶段 | 数据 | 结论 |
|---|---|---|
| 断连压测 | 151 client_aborts / 0 errors；mock：total=152 stream=152 abort_close=151 fail=0 | 主动断连全部在 300ms 中止，上游确实被调用 |
| 断连后探测 | 6/6 请求 200 且流完整（`[DONE]`），`no_upstream_key` **0 次** | 熔断器保持 closed，未被取消误开 |
| 真实失败（mock FAIL_RATE=1，全新实例） | 前 5 次 `upstream_error`（105/27/28/27/30ms）→ 第 6-8 次 `no_upstream_key`（24/22/22ms） | 真实失败仍在第 5 个样本后正常熔断 |
| 稳态回归（无断连） | 2978 次完整会话，errors 0，p95 **498.62ms** | 与修复前 485-507ms 同量级，正常路径无影响 |

单测：`npx vitest run tests/unit/router-circuit.test.ts` → 17/17 通过（新增取消隔离 3 例 + `isClientAbort` 5 例）。

