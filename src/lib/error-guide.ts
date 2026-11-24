// b7：失败原因弹窗 —— 错误码 / 状态码 → 人话（发生了什么）+ 建议动作
// 口径：只做展示层解释，不改变接口错误码与响应体；未知错误原样展示服务端 message。

export type ErrorGuideAction = { label: string; href?: string };

export type ErrorGuide = {
  /** 是否命中已知错误口径（未知错误仍可展示，仅提示信息更通用） */
  matched: boolean;
  code: string;
  title: string;
  detail: string;
  actions: ErrorGuideAction[];
};

type Spec = { title: string; detail: string; actions: ErrorGuideAction[] };

const RETRY: ErrorGuideAction = { label: "稍后重试" };
const DOCS: ErrorGuideAction = { label: "查看接口文档", href: "/api-docs" };
const RECHARGE: ErrorGuideAction = { label: "去充值", href: "/recharge" };
const CREDIT_RULES: ErrorGuideAction = { label: "查看积分规则", href: "/credit-rules" };
const PLAYGROUND: ErrorGuideAction = { label: "返回实验场", href: "/playground" };

const BY_CODE: Record<string, Spec> = {
  insufficient_credits: {
    title: "积分不足",
    detail: "当前积分不够这次请求。按模型定价扣减，充值后即可继续调用。",
    actions: [RECHARGE, CREDIT_RULES],
  },
  min_balance_required: {
    title: "未达到模型准入门槛",
    detail: "该模型要求账户余额不低于门槛值，充值到门槛以上即可使用。",
    actions: [RECHARGE, CREDIT_RULES],
  },
  model_not_allowed: {
    title: "该 API Key 未授权此模型",
    detail: "这把 Key 设置了模型白名单，本次请求的模型不在其中，未扣分。可在会员中心调整名单或换用其它 Key。",
    actions: [{ label: "管理 API Key", href: "/member?tab=apikeys" }, CREDIT_RULES],
  },
  key_quota_exceeded: {
    title: "该 API Key 额度已用完",
    detail:
      "这把 Key 的可用额度已经用满，本次请求没有扣分。可在会员中心调高额度，或换用其它 Key。",
    actions: [{ label: "管理 API Key", href: "/member?tab=apikeys" }, CREDIT_RULES],
  },
  quota_exceeded: {
    title: "请求过于频繁",
    detail: "触发了平台的每分钟限额，稍等几秒再发；批量调用请降低频率。",
    actions: [RETRY, DOCS],
  },
  concurrency_exceeded: {
    title: "并发数已满",
    detail: "同时执行的任务达到上限，等前面的任务结束再提交。",
    actions: [RETRY, DOCS],
  },
  upstream_rate_limited: {
    title: "上游限流",
    detail: "厂商侧触发限流，稍后重试即可；失败不会重复扣费。",
    actions: [RETRY, DOCS],
  },
  upstream_concurrency: {
    title: "上游并发已满",
    detail: "厂商侧并发名额用尽，稍后重试或换一个模型。",
    actions: [RETRY, PLAYGROUND],
  },
  no_upstream_key: {
    title: "该模型暂无可用通道",
    detail: "上游 Key 全部不可用或尚未配置，可先换用其它模型。",
    actions: [PLAYGROUND, DOCS],
  },
  upstream_error: {
    title: "上游服务异常",
    detail: "厂商侧返回错误，失败任务会自动退回积分，稍后重试即可。",
    actions: [RETRY, DOCS],
  },
  upstream_timeout: {
    title: "上游超时",
    detail: "厂商侧响应超时，失败任务会自动退回积分，稍后重试即可。",
    actions: [RETRY, DOCS],
  },
  upstream_task_failed: {
    title: "上游任务失败",
    detail: "厂商侧任务执行失败，已按规则退回积分；可调整参数后重试。",
    actions: [RETRY, PLAYGROUND],
  },
  invalid_api_key: {
    title: "API Key 无效",
    detail: "Key 已撤销、过期或复制不完整，请在会员中心重新创建。",
    actions: [{ label: "管理 API Key", href: "/member?tab=apikeys" }],
  },
  not_authenticated: {
    title: "登录已失效",
    detail: "请重新登录后再发起请求。",
    actions: [{ label: "去登录", href: "/login?next=/playground" }],
  },
  unauthorized: {
    title: "登录已失效",
    detail: "请重新登录后再发起请求。",
    actions: [{ label: "去登录", href: "/login?next=/playground" }],
  },
  account_suspended: {
    title: "账号已被封禁",
    detail: "当前账号处于封禁状态，无法调用生成接口；如有疑问请提交工单。",
    actions: [{ label: "联系管理员", href: "/member?tab=messages" }],
  },
  model_not_found: {
    title: "模型不存在或已下线",
    detail: "该模型已下线或当前不可用，请在实验场重新选择模型。",
    actions: [PLAYGROUND, DOCS],
  },
  endpoint_disabled: {
    title: "该模型不支持当前接口",
    detail: "模型与接口不匹配，请换用支持该能力的模型。",
    actions: [PLAYGROUND, DOCS],
  },
  pricing_not_configured: {
    title: "模型价格未配置",
    detail: "平台尚未完成该模型定价，暂时无法调用；请换用其它模型。",
    actions: [PLAYGROUND],
  },
  task_not_found: {
    title: "任务不存在",
    detail: "任务可能已过期或不属于当前账号，请回到实验场重新发起。",
    actions: [PLAYGROUND],
  },
  skill_not_found: {
    title: "技能不存在",
    detail: "技能可能已下线，请回到技能库重新选择。",
    actions: [{ label: "返回技能库", href: "/skills" }],
  },
  skill_not_whitelisted: {
    title: "技能暂不可在实验场运行",
    detail: "该技能缺少实验场所需的配置或能力，请换一个技能。",
    actions: [{ label: "返回技能库", href: "/skills" }],
  },
  request_in_progress: {
    title: "上一次请求还在处理",
    detail: "同一幂等键的请求尚未结束，稍等片刻再查询结果，不要重复提交。",
    actions: [RETRY],
  },
  invalid_body: {
    title: "请求参数不合法",
    detail: "检查模型名、参数范围与请求体格式后重试。",
    actions: [DOCS],
  },
  file_too_large: {
    title: "文件太大",
    detail: "超出该接口允许的上限，请压缩或裁剪后重新上传。",
    actions: [PLAYGROUND],
  },
};

const BY_STATUS: Record<number, Spec> = {
  400: { title: "请求参数不合法", detail: "服务端拒绝了这次请求，检查参数与请求体后重试。", actions: [DOCS] },
  401: { title: "未登录或凭证失效", detail: "请重新登录后再试。", actions: [{ label: "去登录", href: "/login" }] },
  402: { title: "积分不足", detail: "当前积分不足以完成这次请求，充值后再试。", actions: [RECHARGE, CREDIT_RULES] },
  403: { title: "没有访问权限", detail: "当前账号无权执行该操作，检查账号状态或联系管理员。", actions: [{ label: "查看账号", href: "/member" }] },
  404: { title: "资源不存在", detail: "请求的地址或对象不存在，确认路径后重试。", actions: [DOCS] },
  409: { title: "请求冲突", detail: "同一请求正在处理或已被处理，稍后查询结果即可。", actions: [RETRY] },
  413: { title: "请求体过大", detail: "文件或请求体超过上限，请压缩后重试。", actions: [DOCS] },
  429: { title: "请求过于频繁", detail: "触发限流，稍等几秒再试；持续出现请降低并发。", actions: [RETRY, DOCS] },
  499: { title: "请求已取消", detail: "客户端主动断开，本次调用未完成。", actions: [PLAYGROUND] },
  500: { title: "服务内部错误", detail: "服务端处理失败，稍后重试；任务类请求失败会自动退回积分。", actions: [RETRY, DOCS] },
  502: { title: "上游服务异常", detail: "厂商侧返回错误，稍后重试；失败任务会自动退回积分。", actions: [RETRY, DOCS] },
  503: { title: "服务暂不可用", detail: "服务正在维护或过载，稍后重试。", actions: [RETRY] },
  504: { title: "上游超时", detail: "上游响应超时，稍后重试。", actions: [RETRY] },
};

export function explainApiError(input: {
  code?: string | null;
  status?: number | null;
  message?: string | null;
}): ErrorGuide {
  const code = (input.code ?? "").trim();
  const status = typeof input.status === "number" ? input.status : null;

  const byCode = code ? BY_CODE[code] : undefined;
  if (byCode) return { matched: true, code, ...byCode };

  const byStatus = status != null ? BY_STATUS[status] : undefined;
  if (byStatus) return { matched: true, code: code || `http_${status}`, ...byStatus };

  const message = (input.message ?? "").trim();
  return {
    matched: false,
    code: code || (status != null ? `http_${status}` : "unknown"),
    title: "请求失败",
    detail: message || "服务暂时无法完成这次请求，请稍后重试。",
    actions: [RETRY, DOCS],
  };
}
