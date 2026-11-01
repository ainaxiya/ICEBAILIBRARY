import { getServerLocale, translate as t } from "@/lib/i18n";

export const dynamic = "force-dynamic";
export const metadata = { title: "API 接口文档" };

// ─── API 接口文档初版（P1 聚合网关） ───
// 内容初版写死在页面（中文为主），后续接入单页系统或后台编辑再迭代。

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-10 mb-4 border-l-2 border-emerald-400/70 pl-3 text-lg font-semibold text-zinc-100">
      {children}
    </h2>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/80 p-4 text-xs leading-relaxed text-emerald-200/90">
      <code>{children}</code>
    </pre>
  );
}

function ParamTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900/70 text-xs uppercase tracking-wider text-zinc-500">
            <th className="px-4 py-2.5 font-medium">参数</th>
            <th className="px-4 py-2.5 font-medium">类型</th>
            <th className="px-4 py-2.5 font-medium">说明</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, ty, desc]) => (
            <tr key={k} className="border-b border-zinc-800/60 last:border-0">
              <td className="px-4 py-2.5 font-mono text-xs text-emerald-300/90">{k}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{ty}</td>
              <td className="px-4 py-2.5 text-zinc-300">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ApiDocsPage() {
  const locale = await getServerLocale();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-2 text-2xl font-bold text-zinc-100">{t(locale, "page.apiDocs.title")}</h1>
      <p className="mb-8 text-sm text-zinc-400">
        本站聚合网关提供 OpenAI 兼容的大模型调用接口，可用于站内应用接入或自有工具调用。
      </p>

      {/* ── 概述 ── */}
      <H2>概述</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-300">
        <li>
          <span className="text-zinc-100">协议</span>：OpenAI 兼容（请求/响应结构与
          <code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">/chat/completions</code>
          一致），支持流式 SSE 与非流式 JSON。
        </li>
        <li>
          <span className="text-zinc-100">Base URL</span>：
          <code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">https://api.wango8.com/v1</code>
          （站内同源请求为 <code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">/v1</code>）
        </li>
        <li>
          <span className="text-zinc-100">鉴权</span>：请求头
          <code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">Authorization: Bearer sk-你的密钥</code>
          。当前版本仅开放<b className="text-emerald-300">站内登录态</b>调用，站外 API Key
          发放与鉴权即将开放（届时在用户中心申请 sk- 密钥）。
        </li>
        <li>
          <span className="text-zinc-100">内容类型</span>：
          <code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">application/json</code>
          ；流式响应为 <code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">text/event-stream</code>。
        </li>
      </ul>

      {/* ── 接口定义 ── */}
      <H2>POST /v1/chat/completions</H2>
      <p className="mb-3 text-sm leading-relaxed text-zinc-300">发起一次对话补全（文本生成）。请求参数：</p>
      <ParamTable
        rows={[
          ["model", "string", "模型名（必填），如 deepseek-chat，以文档/站内公布的模型列表为准"],
          ["messages", "array", "对话消息数组（必填），元素为 { role, content }，role 取 system / user / assistant"],
          ["stream", "boolean", "是否流式返回，默认 false。true 时以 SSE 增量推送"],
          ["temperature", "number", "采样温度 0-2，默认 1"],
          ["max_tokens", "integer", "最大输出 token 数"],
          ["top_p", "number", "核采样 0-1，默认 1"],
          ["stop", "string | string[]", "停止序列（可选）"],
          ["presence_penalty", "number", "存在惩罚（可选）"],
          ["frequency_penalty", "number", "频率惩罚（可选）"],
          ["user", "string", "终端用户标识（可选，用于上游风控）"],
        ]}
      />

      <h3 className="mt-6 mb-2 text-sm font-semibold text-zinc-200">请求示例</h3>
      <Code>{`curl https://api.wango8.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-你的密钥" \\
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "你是一个简洁的助手" },
      { "role": "user", "content": "用一句话介绍杭州" }
    ],
    "stream": false
  }'`}</Code>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-zinc-200">响应示例（非流式）</h3>
      <Code>{`{
  "id": "chatcmpl-9f2c1a",
  "object": "chat.completion",
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "杭州是…" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 23, "completion_tokens": 16, "total_tokens": 39 }
}`}</Code>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-zinc-200">响应示例（SSE 流式，stream: true）</h3>
      <Code>{`data: {"id":"chatcmpl-9f2c1a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"杭州"},"finish_reason":null}]}

data: {"id":"chatcmpl-9f2c1a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"是…"},"finish_reason":null}]}

data: {"id":"chatcmpl-9f2c1a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]`}</Code>

      {/* ── 错误码 ── */}
      <H2>错误码</H2>
      <p className="mb-3 text-sm leading-relaxed text-zinc-300">
        出错时返回 JSON：<code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">{`{ "error": { "message", "type", "code" } }`}</code>
      </p>
      <ParamTable
        rows={[
          ["400", "invalid_request_error", "请求参数不合法（缺少 model / messages 等）"],
          ["401", "authentication_error", "未登录或 API Key 无效 / 未启用"],
          ["402", "insufficient_quota", "积分不足（余额低于预估扣分，或低于图片/视频门槛），请先充值"],
          ["404", "invalid_request_error", "模型不存在、已下线或未开启对应端点"],
          ["429", "rate_limit_error", "触发限流（调用频率/配额超限），请稍后重试"],
          ["502", "api_error", "上游模型服务调用失败（已自动切换通道重试仍未成功），本次不扣费"],
        ]}
      />

      {/* ── 计费 ── */}
      <H2>计费说明</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-300">
        <li>
          以<b className="text-emerald-300">整数积分</b>计费：按实际用量换算成本后
          <code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">向上取整（ceil）</code>
          到整数积分，<b className="text-emerald-300">每次调用最低 1 积分</b>。
        </li>
        <li>调用前按预估用量预扣，结束后按实际用量结算，多退少补；调用失败（502）全额退回，不扣费。</li>
        <li>输入与输出分别计价（输出单价通常高于输入），具体单价以站内模型列表标价为准。</li>
        <li>
          <b className="text-emerald-300">门槛预告</b>：图片 / 视频类生成接口上线后，账户积分
          <code className="mx-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs text-emerald-300">低于 200</code>
          时将被拒绝调用（返回 402），文本接口不受此门槛限制。
        </li>
        <li>每次调用的用量明细（token 数、扣分、耗时）可在用户中心查看。</li>
      </ul>

      <p className="mt-10 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-xs leading-relaxed text-zinc-500">
        本文档为初版，接口仍在快速迭代中；如需协助或发现问题，请通过「联系我们」页面反馈。
      </p>
    </div>
  );
}
