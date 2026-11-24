import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/rbac";
import { getGuestTrialConfig, getGuestRemaining } from "@/lib/playground/settings";

export const dynamic = "force-dynamic";

// 游客试玩状态：前台据此显示剩余次数 / 登录引导，不暴露其它配置
export async function GET() {
  const cfg = await getGuestTrialConfig();
  const ip = (await getClientIp()) || "unknown";
  const remaining = cfg.enabled ? await getGuestRemaining(ip, cfg.maxTrials) : 0;
  return NextResponse.json(
    { enabled: cfg.enabled, maxTrials: cfg.maxTrials, remaining },
    { headers: { "Cache-Control": "no-store" } }
  );
}
