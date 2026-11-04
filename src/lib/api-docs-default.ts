// ─── API 接口文档 · 内置默认正文（HTML 常量） ───
// 由原 ApiDocsContent.tsx 的 11 章 JSX 正文完整转换而来，是文档的单一默认真源：
// SiteSetting.api_docs_html 为空时渲染本常量；后台「恢复默认文档」即清空库中自定义内容回到本文。
//
// 占位符（渲染时替换，勿在编辑器里破坏）：
//   {{BASE_URL}}    → SiteSetting.api_docs_base_url（空则用 DEFAULT_API_DOCS_BASE_URL）
//   {{MODEL_TABLE}} → 服务端实时查库生成的在线模型目录表
//
// 样式：正文标签（h2/h3/p/ul/table/pre/code 等）由 globals.css 的 .api-docs-prose 暗色样式统一驱动，
// class="hl" = 高亮标签，table.params = 参数表，table.models = 模型目录表，p.note = 文末提示。

export const DEFAULT_API_DOCS_BASE_URL = "https://api.wango8.com/v1";

// SiteSetting 存储键（value 均为字符串；空 = 使用内置默认）
export const API_DOCS_HTML_SETTING_KEY = "api_docs_html";
export const API_DOCS_BASE_URL_SETTING_KEY = "api_docs_base_url";

export const BASE_URL_PLACEHOLDER = "{{BASE_URL}}";
export const MODEL_TABLE_PLACEHOLDER = "{{MODEL_TABLE}}";

export const DEFAULT_API_DOCS_HTML = `<h2 id="overview">概述与快速开始</h2>
<ul>
  <li><span class="hl">协议</span>：OpenAI 兼容（请求 / 响应结构与<code>/chat/completions</code>一致），支持流式 SSE 与非流式 JSON。可直接使用 OpenAI 官方 SDK，只需替换<code>base_url</code>。</li>
  <li><span class="hl">三类端点</span>：对话<code>POST /v1/chat/completions</code>；图像 / 视频生成共用<code>POST /v1/images/generations</code>（由模型类型自动区分）；模型列表 <code>GET /v1/models</code>。</li>
  <li><span class="hl">内容类型</span>：请求体<code>application/json</code>；响应为 JSON，流式响应为 <code>text/event-stream</code>（SSE）。编码 UTF-8。</li>
</ul>
<h3>30 秒上手：一条 curl 调通对话接口</h3>
<pre><code>curl {{BASE_URL}}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-你的密钥" \\
  -d '{
    "model": "deepseek-chat",
    "messages": [{ "role": "user", "content": "用一句话介绍杭州" }]
  }'</code></pre>
<p>返回 OpenAI 兼容的 <code>chat.completion</code> JSON。其中<code>model</code> 填<strong>模型名</strong>（见下文「模型列表与模型选择」），<code>sk-你的密钥</code> 在会员中心「API Key」页生成。</p>
<h2 id="auth">Base URL 与认证</h2>
<ul>
  <li><span class="hl">Base URL</span>：<code>http(s)://&lt;本站域名&gt;/v1</code>，本站为 <code>{{BASE_URL}}</code>（站内同源请求为 <code>/v1</code>）。</li>
  <li><span class="hl">鉴权方式</span>：每个请求携带请求头<code>Authorization: Bearer sk-你的密钥</code>。站内页面脚本也可用登录态同源调用（无需 Authorization 头），站外一律用 API Key。</li>
  <li><span class="hl">生成 Key</span>：在<span class="hl">会员中心 → API Key</span> 页签生成<code>sk-</code> 密钥，明文仅创建时显示一次，请妥善保存。</li>
  <li>支持<b>多把 Key</b> 并存：可为每把 Key <b>命名</b>（便于区分脚本 / 项目），可设置<b>过期时间</b>，也可随时<b>吊销</b>；吊销后立即失效且不可恢复。</li>
</ul>
<pre><code>Authorization: Bearer sk-你的密钥</code></pre>
<h3>401 认证失败</h3>
<p>Key 无效 / 已吊销 / 已过期 / 格式错误（非 <code>sk-</code> 开头）、账号不可用，或未携带 Authorization 头且未登录，均返回 <code>401</code>：</p>
<pre><code>{
  "error": {
    "message": "API Key 已吊销",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}</code></pre>
<h2 id="models">模型列表与模型选择</h2>
<p><b>重要</b>：请求里的<code>model</code> 参数填<strong>模型名</strong>，不是厂商名。一个厂商下有多个模型，每个模型有独立的模型名——例如<code>deepseek-chat</code> 与 <code>deepseek-reasoner</code> 是同一厂商（DeepSeek）下的两个不同模型名，能力与计价各自独立。填错（如填厂商名）会返回<code>404 model_not_found</code>。</p>
<p><code>endpoint_type</code> 决定调用哪个端点：<code>chat</code> → <code>/v1/chat/completions</code>；<code>image</code> / <code>video</code> → <code>/v1/images/generations</code>（视频与图像共用同一端点，由模型类型区分）。</p>
<h3>GET /v1/models（可编程查询）</h3>
<pre><code>curl {{BASE_URL}}/models \\
  -H "Authorization: Bearer sk-你的密钥"</code></pre>
<pre><code>{
  "object": "list",
  "data": [
    {
      "id": "deepseek-chat",
      "object": "model",
      "created": 1730000000,
      "owned_by": "DeepSeek",
      "endpoint_type": "chat"
    },
    {
      "id": "wanx-image",
      "object": "model",
      "created": 1730000000,
      "owned_by": "多模型平台",
      "endpoint_type": "image"
    }
  ]
}</code></pre>
<div class="tbl"><table class="params">
<thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead>
<tbody>
<tr><td>id</td><td>string</td><td>模型名——请求里 model 参数填这个值</td></tr>
<tr><td>object</td><td>string</td><td>固定 model</td></tr>
<tr><td>created</td><td>integer</td><td>模型入库时间（Unix 秒）</td></tr>
<tr><td>owned_by</td><td>string</td><td>厂商显示名</td></tr>
<tr><td>endpoint_type</td><td>string</td><td>模型类型：chat / image / video，决定调用哪个端点</td></tr>
</tbody>
</table></div>
<h3>在线模型目录（实时数据）</h3>
<p>下表为站内 <code>status=online</code> 的实时模型列表；计价单位含义：<code>token</code>=按百万 token 计价、<code>image</code>=按张计价、<code>video_second</code>=按秒 × 条数计价、<code>request</code>=按次计价。具体单价以站内模型列表标价为准。</p>
{{MODEL_TABLE}}
<h2 id="chat">Chat Completions</h2>
<p><code>POST /v1/chat/completions</code>：发起一次对话补全（文本生成），需使用 <code>chat</code> 类型的模型。</p>
<h3>请求头</h3>
<div class="tbl"><table class="params">
<thead><tr><th>请求头</th><th>类型</th><th>必填</th><th>说明</th></tr></thead>
<tbody>
<tr><td>Content-Type</td><td>string</td><td>是</td><td>固定 application/json</td></tr>
<tr><td>Authorization</td><td>string</td><td>是</td><td>Bearer sk-你的密钥</td></tr>
</tbody>
</table></div>
<h3>请求参数（JSON Body）</h3>
<div class="tbl"><table class="params">
<thead><tr><th>参数</th><th>类型</th><th>必填</th><th>默认值</th><th>说明</th></tr></thead>
<tbody>
<tr><td>model</td><td>string</td><td>是</td><td>—</td><td>模型名（见「模型列表与模型选择」），如 deepseek-chat</td></tr>
<tr><td>messages</td><td>array</td><td>是</td><td>—</td><td>对话消息数组，元素为 { role, content }；role 取 system / user / assistant，至少 1 条</td></tr>
<tr><td>stream</td><td>boolean</td><td>否</td><td>false</td><td>true 时以 SSE 增量推送（见下文流式格式）</td></tr>
<tr><td>temperature</td><td>number</td><td>否</td><td>上游默认</td><td>采样温度，取值 0-2，越高越发散</td></tr>
<tr><td>top_p</td><td>number</td><td>否</td><td>上游默认</td><td>核采样，取值 0-1，与 temperature 二选一调节即可</td></tr>
<tr><td>max_tokens</td><td>integer</td><td>否</td><td>模型上限</td><td>最大输出 token 数（正整数，不含输入）</td></tr>
<tr><td>stop</td><td>string | string[]</td><td>否</td><td>null</td><td>停止序列，命中即结束生成</td></tr>
<tr><td>presence_penalty</td><td>number</td><td>否</td><td>上游默认</td><td>存在惩罚，取值 -2 到 2</td></tr>
<tr><td>frequency_penalty</td><td>number</td><td>否</td><td>上游默认</td><td>频率惩罚，取值 -2 到 2</td></tr>
<tr><td>user</td><td>string</td><td>否</td><td>null</td><td>终端用户标识（用于上游风控与滥用排查）</td></tr>
</tbody>
</table></div>
<p>其余字段（如 <code>tools</code>、<code>response_format</code> 等）会<b>原样透传</b>给上游，是否生效取决于所选模型的上游支持情况。</p>
<h3>响应结构（非流式）</h3>
<p>返回上游 OpenAI 兼容的 <code>chat.completion</code> JSON（原样透传），主要字段：</p>
<div class="tbl"><table class="params">
<thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead>
<tbody>
<tr><td>id</td><td>string</td><td>本次补全的唯一 ID</td></tr>
<tr><td>object</td><td>string</td><td>固定 chat.completion（流式为 chat.completion.chunk）</td></tr>
<tr><td>created</td><td>integer</td><td>创建时间（Unix 秒）</td></tr>
<tr><td>model</td><td>string</td><td>实际使用的模型</td></tr>
<tr><td>choices</td><td>array</td><td>补全结果：choices[0].message（或流式 delta）与 finish_reason</td></tr>
<tr><td>usage</td><td>object</td><td>token 用量：prompt_tokens / completion_tokens / total_tokens</td></tr>
</tbody>
</table></div>
<pre><code>{
  "id": "chatcmpl-9f2c1a",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "杭州是…" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 23,
    "completion_tokens": 16,
    "total_tokens": 39
  }
}</code></pre>
<p>本次实扣积分不在响应体内，可在<span class="hl">会员中心 → 用量明细</span>按日 / 按模型 / 按 Key 查询（计费规则见「计费说明」）。</p>
<h3>SSE 流式响应（stream: true）</h3>
<ul>
  <li>响应头 <code>Content-Type: text/event-stream</code>，每个事件为一行<code>data: </code> 后跟 JSON（<code>chat.completion.chunk</code>），事件之间以空行分隔。</li>
  <li>内容增量在 <code>choices[0].delta.content</code> 中逐段下发；最后一个 chunk 的 <code>finish_reason</code> 为<code>stop</code>（或 <code>length</code>）。</li>
  <li>网关会要求上游在流末尾附带 <code>usage</code>（token 用量）；流以单独一行<code>data: [DONE]</code> 结束（OpenAI 兼容上游），收到后即可关闭连接。</li>
</ul>
<pre><code>data: {"id":"chatcmpl-9f2c1a","object":"chat.completion.chunk","created":1730000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"杭州"},"finish_reason":null}]}

data: {"id":"chatcmpl-9f2c1a","object":"chat.completion.chunk","created":1730000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"是…"},"finish_reason":null}]}

data: {"id":"chatcmpl-9f2c1a","object":"chat.completion.chunk","created":1730000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":23,"completion_tokens":16,"total_tokens":39}}

data: [DONE]</code></pre>
<p>流式为<b>逐块透传</b>，字段以所选模型上游为准；客户端只需按<code>data: </code> 行解析 JSON 并拼接 <code>delta.content</code>。</p>
<h2 id="image">图像生成</h2>
<p><code>POST /v1/images/generations</code>：使用 <code>image</code> 类型的模型生成图像，一次可生成多张。</p>
<h3>请求参数（JSON Body）</h3>
<div class="tbl"><table class="params">
<thead><tr><th>参数</th><th>类型</th><th>必填</th><th>默认值</th><th>说明</th></tr></thead>
<tbody>
<tr><td>model</td><td>string</td><td>是</td><td>—</td><td>图像类模型名（endpoint_type=image），如 wanx-image</td></tr>
<tr><td>prompt</td><td>string</td><td>是</td><td>—</td><td>生成提示词（UTF-8）</td></tr>
<tr><td>n</td><td>integer</td><td>否</td><td>1</td><td>生成张数，取值 1-10；计费按实际产物张数结算</td></tr>
<tr><td>其他字段</td><td>any</td><td>否</td><td>—</td><td>如 size / quality 等原样透传给上游，是否生效取决于上游支持</td></tr>
</tbody>
</table></div>
<h3>响应结构</h3>
<pre><code>{
  "created": 1730000000,
  "data": [
    {
      "url": "https://api.wango8.com/api/member/assets/123/download",
      "asset_id": "123",
      "transfer_status": "stored"
    }
  ]
}</code></pre>
<div class="tbl"><table class="params">
<thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead>
<tbody>
<tr><td>created</td><td>integer</td><td>创建时间（Unix 秒）</td></tr>
<tr><td>data</td><td>array</td><td>产物数组，每个元素对应一张图</td></tr>
<tr><td>data[].url</td><td>string | null</td><td>本站访问地址（受保护的私有下载地址，会过期，请及时转存）</td></tr>
<tr><td>data[].asset_id</td><td>string | null</td><td>生成资产 ID，可在会员中心「生成资产」查看与管理</td></tr>
<tr><td>data[].transfer_status</td><td>string</td><td>stored=已转存本站存储；retry_available=转存失败，可用 source_url 兜底（资产已记录，可在会员中心重试拉取一次）</td></tr>
<tr><td>data[].source_url</td><td>string</td><td>仅转存失败时返回：上游临时产物地址（有效期短，建议立即下载）</td></tr>
</tbody>
</table></div>
<h3>调用示例（curl）</h3>
<pre><code>curl {{BASE_URL}}/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-你的密钥" \\
  -d '{
    "model": "wanx-image",
    "prompt": "一只在雪地里奔跑的柴犬，电影感",
    "n": 2
  }'</code></pre>
<h2 id="video">视频生成</h2>
<p>视频生成<b>使用同一个端点</b><code>POST /v1/images/generations</code>，只需把 <code>model</code> 换成 <code>video</code> 类型的模型（见在线模型目录）。网关按模型类型自动走「提交任务 → 轮询 → 取结果」的异步流程。</p>
<h3>请求参数（JSON Body）</h3>
<div class="tbl"><table class="params">
<thead><tr><th>参数</th><th>类型</th><th>必填</th><th>默认值</th><th>说明</th></tr></thead>
<tbody>
<tr><td>model</td><td>string</td><td>是</td><td>—</td><td>视频类模型名（endpoint_type=video）</td></tr>
<tr><td>prompt</td><td>string</td><td>是</td><td>—</td><td>生成提示词（UTF-8）</td></tr>
<tr><td>n</td><td>integer</td><td>否</td><td>1</td><td>生成条数，取值 1-10</td></tr>
<tr><td>duration</td><td>number</td><td>否</td><td>5（预估用）</td><td>视频时长（秒），取值 1-600；计费按秒 × 条数，预扣按 5 秒估算、结算按实际</td></tr>
<tr><td>其他字段</td><td>any</td><td>否</td><td>—</td><td>原样透传给上游，是否生效取决于上游支持</td></tr>
</tbody>
</table></div>
<h3>同步长耗时请求</h3>
<ul>
  <li>这是一个<b>同步长耗时</b>请求：网关内部提交生成任务后每 5 秒轮询一次状态，直到产出结果再一次性返回；任务等待上限为<b>10 分钟</b>，超时按失败处理（全额退回，不扣费）。</li>
  <li><b>客户端超时建议 ≥ 300 秒</b>（含代理 / 网关 / SDK 的整体读超时），实际生成可能耗时数十秒到数分钟。</li>
  <li>响应结构与图像生成完全一致（created + data 数组，含 url / asset_id / transfer_status）。</li>
  <li>计费按<b>秒 × 条数</b>：例如 duration=5、n=2 且成功产出 2 条 → 按 10 秒结算。</li>
</ul>
<h3>调用示例（curl）</h3>
<pre><code>curl {{BASE_URL}}/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-你的密钥" \\
  --max-time 360 \\
  -d '{
    "model": "wanx-video",
    "prompt": "航拍雪山日出，缓慢推进镜头",
    "n": 1,
    "duration": 5
  }'</code></pre>
<h2 id="billing">计费说明</h2>
<ul>
  <li><span class="hl">计费流程</span>：调用前按估算<b>预扣</b>积分；成功后按实际用量<b>结算</b>（多退少补，补扣封顶为预估的 3 倍）；上游失败<b>全额退回</b>，不扣费。</li>
  <li><span class="hl">结算口径</span>：文本按实际 token 用量；图像 / 视频按<b>实际产物数量</b>（图像按张、视频按秒 × 条数）。换算成本后<code>向上取整（ceil）</code>到整数积分，<b>每次调用最低 1 积分</b>。</li>
  <li><span class="hl">计价单位</span>：<code>token</code>=按百万 token、<code>image</code>=按张、<code>video_second</code>=按秒 × 条、<code>request</code>=按次；输入与输出分别计价（输出单价通常高于输入）。</li>
  <li><span class="hl">定价构成</span>：定价包含供应商币种<b>汇率换算</b>与<b>加价系数</b>，用户侧统一以<b>积分</b>结算，不区分上游币种；具体单价以站内模型列表标价为准。</li>
  <li><b>生图 / 生视频门槛</b>：账户积分<code>低于 200</code>时禁止调用图像 / 视频生成接口（返回 402），文本接口不受此门槛限制。</li>
  <li><b>失败不扣费</b>：4xx / 5xx 失败（含 502 上游失败、视频任务超时）预扣积分全额退回。</li>
  <li>每次调用的用量明细（token 数 / 产物数、扣分）与积分明细可在会员中心查看。</li>
</ul>
<h2 id="rate-limits">频率限制与配额</h2>
<ul>
  <li><span class="hl">站外 API Key 通道</span>：每把 Key<b>每分钟 60 次（RPM）</b>；会员层每日调用次数不设限。</li>
  <li><span class="hl">站内登录态通道</span>：每会员每日<b>2000 次</b>、每分钟 <b>60 次</b>（默认值，以站内实际配置为准，后台可调）。</li>
  <li><span class="hl">并发槽</span>：每会员同时在途请求默认<b>4 个</b>；超出后本次预扣立即退回并返回 429。</li>
  <li>超限返回 <code>429</code>：<code>code=quota_exceeded</code>（日次数 / RPM 超限）或 <code>code=concurrency_exceeded</code>（并发超限）。建议指数退避重试（如 1s → 2s → 4s）。</li>
</ul>
<h2 id="errors">错误码总表</h2>
<p>出错时返回 JSON：<code>{ "error": { "message", "type", "code" } }</code>，HTTP 状态码与错误含义如下（适用于全部 /v1 端点）：</p>
<div class="tbl"><table class="params">
<thead><tr><th>HTTP 状态</th><th>type</th><th>code</th><th>说明</th></tr></thead>
<tbody>
<tr><td>400</td><td>invalid_request_error</td><td>invalid_body</td><td>请求参数不合法（缺少 model / messages / prompt、JSON 解析失败、n 超出 1-10、duration 超出 1-600 等）</td></tr>
<tr><td>401</td><td>authentication_error</td><td>invalid_api_key</td><td>API Key 无效 / 已吊销 / 已过期 / 格式错误，或账号不可用</td></tr>
<tr><td>401</td><td>authentication_error</td><td>not_authenticated</td><td>未携带 Authorization 头且未登录站内账号</td></tr>
<tr><td>402</td><td>insufficient_quota</td><td>insufficient_credits</td><td>积分不足（余额低于预估扣分），或余额低于 200 积分调用生图 / 生视频，请先充值后重试</td></tr>
<tr><td>404</td><td>invalid_request_error</td><td>model_not_found</td><td>模型不存在或已下线（model 参数可能填了厂商名，应填模型名）</td></tr>
<tr><td>404</td><td>invalid_request_error</td><td>endpoint_disabled</td><td>该模型不支持此端点，或对应端点未开启（如 chat 模型调生成端点）</td></tr>
<tr><td>404</td><td>invalid_request_error</td><td>pricing_not_configured</td><td>模型未配置定价，暂不可用</td></tr>
<tr><td>429</td><td>rate_limit_error</td><td>quota_exceeded</td><td>调用频率 / 配额超限（日次数或 RPM），请退避后重试</td></tr>
<tr><td>429</td><td>rate_limit_error</td><td>concurrency_exceeded</td><td>并发请求数超限，请稍后再试</td></tr>
<tr><td>502</td><td>api_error</td><td>no_upstream_key</td><td>模型暂无可用上游通道，请联系我们</td></tr>
<tr><td>502</td><td>api_error</td><td>upstream_error</td><td>上游模型服务调用失败（已自动换通道重试最多 3 次仍未成功），本次不扣费</td></tr>
</tbody>
</table></div>
<h3>错误响应示例</h3>
<pre><code>// 402 积分不足
HTTP/1.1 402 Payment Required
{
  "error": {
    "message": "余额不足 200 积分，无法使用生图/生视频",
    "type": "insufficient_quota",
    "code": "insufficient_credits"
  }
}

// 401 Key 已吊销
HTTP/1.1 401 Unauthorized
{
  "error": {
    "message": "API Key 已吊销",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}

// 429 限流
HTTP/1.1 429 Too Many Requests
{
  "error": {
    "message": "调用过于频繁（每分钟限额），请稍后再试",
    "type": "rate_limit_error",
    "code": "quota_exceeded"
  }
}</code></pre>
<h2 id="examples">调用示例汇总</h2>
<h3>curl：Chat 流式（SSE）</h3>
<pre><code>curl {{BASE_URL}}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-你的密钥" \\
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "你是一个简洁的助手" },
      { "role": "user", "content": "用一句话介绍杭州" }
    ],
    "temperature": 0.7,
    "max_tokens": 256,
    "stream": true
  }'</code></pre>
<h3>Python（openai SDK，流式 + 非流式）</h3>
<pre><code>from openai import OpenAI

client = OpenAI(
    api_key="sk-你的密钥",
    base_url="{{BASE_URL}}",  # 指向本站
)

# 非流式
resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "用一句话介绍杭州"}],
    temperature=0.7,
    max_tokens=256,
)
print(resp.choices[0].message.content)
print(resp.usage)  # token 用量

# 流式：stream=True，逐块读取
stream = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "用一句话介绍杭州"}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)

# 图像 / 视频生成（同一端点，换成对应模型名；超时给足）
media = client.images.generate(
    model="wanx-image",
    prompt="一只在雪地里奔跑的柴犬，电影感",
    n=2,
    timeout=360,
)
print(media.data)</code></pre>
<h3>Node.js（fetch / openai SDK）</h3>
<pre><code>// 原生 fetch：Chat 非流式
const resp = await fetch("{{BASE_URL}}/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer sk-你的密钥",
  },
  body: JSON.stringify({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "用一句话介绍杭州" }],
  }),
});
const json = await resp.json();
console.log(json.choices[0].message.content);

// openai SDK：Chat 流式
import OpenAI from "openai";
const client = new OpenAI({ apiKey: "sk-你的密钥", baseURL: "{{BASE_URL}}" });
const stream = await client.chat.completions.create({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "用一句话介绍杭州" }],
  stream: true,
});
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) process.stdout.write(delta);
}

// 视频生成：同一端点 + 视频模型名，客户端超时 ≥300 秒
const video = await client.images.generate({
  model: "wanx-video",
  prompt: "航拍雪山日出，缓慢推进镜头",
  n: 1,
  duration: 5,
  timeout: 360,
});
console.log(video.data);</code></pre>
<h3>curl：视频生成（--max-time 给足超时）</h3>
<pre><code>curl {{BASE_URL}}/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-你的密钥" \\
  --max-time 360 \\
  -d '{"model":"wanx-video","prompt":"航拍雪山日出","n":1,"duration":5}'</code></pre>
<h2 id="faq">常见问题 FAQ</h2>
<ul>
  <li><span class="hl">model 参数怎么填？</span>填<span class="hl">模型名</span>（如 <code>deepseek-chat</code>），不是厂商名；一个厂商下有多个模型名。用 <code>GET /v1/models</code> 或本文档的在线模型目录查询，填错会报 404 model_not_found。</li>
  <li><span class="hl">API Key 在哪生成？</span>会员中心 →「API Key」页签。支持多把 Key、命名、设过期时间、随时吊销；明文仅创建时显示一次，泄露请立即吊销重生成。</li>
  <li><span class="hl">余额不足（402）怎么办？</span>充值到账后重试即可，预扣失败不会产生扣费；生图 / 生视频还要求余额<code>≥ 200</code> 积分。</li>
  <li><span class="hl">生成的图片 / 视频在哪里看？</span>会员中心「生成资产」页查看与下载。响应里的 <code>url</code> 是本站受保护的私有下载地址（会过期），请及时转存；<code>transfer_status=retry_available</code> 表示转存失败，可先用 <code>source_url</code> 兜底下载，或在会员中心重试拉取。</li>
  <li><span class="hl">能否用 OpenAI 官方 SDK？</span>可以。请求 / 响应结构与 OpenAI 兼容，只需把<code>base_url</code>（Python）/ <code>baseURL</code>（Node）指向 <code>{{BASE_URL}}</code>，<code>api_key</code> 填本站的 <code>sk-</code> 密钥。</li>
  <li><span class="hl">视频生成很慢 / 超时？</span>视频为同步长耗时请求（内部提交 → 每 5 秒轮询 → 取结果，等待上限 10 分钟），请把客户端超时设为<code>≥ 300 秒</code>；超时或失败全额退回，不扣费。</li>
  <li><span class="hl">流式中断怎么算？</span>SSE 连接中途断开按失败处理，预扣积分全额退回（不扣费）；需要完整结果时可改用非流式调用。</li>
  <li><span class="hl">调用记录在哪看？</span>会员中心「用量明细」按日 / 按模型 / 按 Key 查询；积分明细在「积分流水」查看。</li>
  <li><span class="hl">Key 安全</span>：请勿将 API Key 写入前端代码或公开仓库；一旦泄露请立即在会员中心吊销并重新生成。</li>
</ul>
<p class="note">本文档随接口迭代持续更新；如需协助或发现问题，请通过「联系我们」页面反馈。</p>`;
