// b3：多客户端接入信息 —— 只收录「支持自定义 OpenAI 兼容 Base URL + API Key」的国产客户端
// 每条的地址字段形态不同：大多数填 Base URL（.../v1），沉浸式翻译要求完整 chat/completions 地址。

export type ClientIntegration = {
  id: string;
  name: string;
  platform: string;
  homepage: string;
  /** base = 填 .../v1；chat-completions = 填 .../v1/chat/completions */
  addressKind: "base" | "chat-completions";
  addressLabel: string;
  steps: string[];
  note?: string;
};

export const CLIENT_INTEGRATIONS: ClientIntegration[] = [
  {
    id: "cherry-studio",
    name: "Cherry Studio",
    platform: "桌面端（Win / macOS / Linux）",
    homepage: "https://www.cherry-ai.com/",
    addressKind: "base",
    addressLabel: "API 地址",
    steps: [
      "设置 → 模型服务 → 添加提供商，类型选择「OpenAI」。",
      "API 地址填 {{base}}，API 密钥填你的 sk- 明文。",
      "在模型列表里添加本站已开放的模型名（与接口文档一致），保存后即可对话。",
    ],
    note: "必须选 OpenAI 兼容类型；部分版本把该入口叫「自定义提供商」。",
  },
  {
    id: "chatbox",
    name: "Chatbox",
    platform: "桌面端 / 网页版",
    homepage: "https://chatboxai.app/zh",
    addressKind: "base",
    addressLabel: "API 域名",
    steps: [
      "设置 → 模型提供方，选择「OpenAI API 兼容」。",
      "API 域名填 {{base}}，API 密钥填你的 sk- 明文。",
      "模型名手动输入本站开放的模型名，保存后新开对话即可使用。",
    ],
    note: "旧版把该字段叫「API Host」，同样填 {{base}}。",
  },
  {
    id: "nextchat",
    name: "NextChat",
    platform: "网页版 / 桌面端",
    homepage: "https://app.nextchat.dev/",
    addressKind: "base",
    addressLabel: "接口地址",
    steps: [
      "左下角设置 → 打开「自定义接口」（Custom Endpoint）。",
      "接口地址填 {{base}}，API Key 填你的 sk- 明文。",
      "添加本站开放的模型名；保存后回对话页选择该模型。",
    ],
    note: "个别版本会自动补 /v1：若报 404，把地址改成根域名再试。",
  },
  {
    id: "immersive-translate",
    name: "沉浸式翻译",
    platform: "浏览器扩展",
    homepage: "https://immersivetranslate.com/",
    addressKind: "chat-completions",
    addressLabel: "自定义 API 接口地址",
    steps: [
      "扩展设置 → 翻译服务 → 添加「OpenAI」并选择自定义接口。",
      "接口地址必须填完整地址 {{endpoint}}（要带 /chat/completions）。",
      "API Key 填你的 sk- 明文，模型名手动填本站开放的模型名。",
    ],
    note: "这里不是填 Base URL；只填 .../v1 会报 404。",
  },
  {
    id: "lobechat",
    name: "LobeChat",
    platform: "自部署（Docker / Vercel）",
    homepage: "https://lobehub.com/zh",
    addressKind: "base",
    addressLabel: "OPENAI_PROXY_URL",
    steps: [
      "自部署时设置环境变量 OPENAI_PROXY_URL={{base}}。",
      "同时设置 OPENAI_API_KEY=你的 sk- 明文，并在模型列表里加入本站模型名。",
      "重启容器后在对话页选择对应模型即可。",
    ],
    note: "官方云端不开放自定义 Base URL，仅自部署版本可通过环境变量接入。",
  },
];

export function clientEndpoint(client: ClientIntegration, baseUrl: string): string {
  return client.addressKind === "chat-completions" ? `${baseUrl}/chat/completions` : baseUrl;
}

export function renderClientStep(
  step: string,
  vars: { base: string; endpoint: string }
): string {
  return step.replaceAll("{{base}}", vars.base).replaceAll("{{endpoint}}", vars.endpoint);
}
