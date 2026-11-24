// ─── 运营告警文案辅助：把内部键/ID 转成运营看得懂的人话 ───
// 约定：告警必须写清「为什么触发 / 是谁 / 会影响什么 / 处理后会怎样」四件事。

// 测试账号前缀：E2E / 压测号不参与运营告警，避免淹没真实问题
export const TEST_ACCOUNT_PREFIX = "qatest_";

export function isTestAccount(username: string | null | undefined): boolean {
  return typeof username === "string" && username.startsWith(TEST_ACCOUNT_PREFIX);
}

// 会员展示名：昵称（账号名）；已注销则明确提示
export function memberLabel(username?: string | null, nickname?: string | null): string {
  if (!username) return "已注销会员";
  return nickname ? `${nickname}（${username}）` : username;
}

const FEATURE_TEXT: Record<string, string> = {
  chat: "文本对话",
  image: "图片生成",
  video: "视频生成",
  audio: "音频合成",
  embedding: "向量嵌入",
  rerank: "重排",
};

// endpointType（usage_record.endpointType / 计费端点）→ 功能中文名
export function featureLabel(endpointType?: string | null): string {
  if (!endpointType) return "其他功能";
  return FEATURE_TEXT[endpointType] || endpointType;
}

// 积分带符号与单位：−21 分 / +5 分
export function signedCredits(value: number | string | bigint): string {
  const n = Number(value);
  const abs = Math.abs(n).toLocaleString("zh-CN");
  return n < 0 ? `−${abs} 分` : `+${abs} 分`;
}

// 时间统一到分钟，便于运营对照调用记录
export function alertTime(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}
