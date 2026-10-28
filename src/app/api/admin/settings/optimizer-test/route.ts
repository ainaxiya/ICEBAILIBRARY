import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { getOptimizerConfig } from "@/lib/settings";

export const dynamic = "force-dynamic";

// POST /api/admin/settings/optimizer-test
// 测试 DeepSeek API 连接：优先用请求体里的 key（尚未保存也能测），否则用已保存/环境变量
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const cfg = await getOptimizerConfig();
  const apiKey = ((body?.apiKey as string) || "").trim() || cfg.apiKey;

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, message: "未配置 API Key：请填写后保存，或在服务器 .env 配置 DEEPSEEK_API_KEY" },
      { status: 400 }
    );
  }

  try {
    // 用 /models 校验 key 有效性，再发一条最小对话验证模型可用
    const modelsRes = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!modelsRes.ok) {
      const detail = await modelsRes.text().catch(() => "");
      return NextResponse.json({
        ok: false,
        message: `鉴权失败（HTTP ${modelsRes.status}）：${detail.slice(0, 200) || "API Key 无效"}`,
      });
    }
    const modelsData = await modelsRes.json().catch(() => ({}));
    const modelIds: string[] = (modelsData.data || []).map((m: { id: string }) => m.id);

    const chatRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "回复：OK" }],
        // 不能太小：推理型模型会先消耗 token 生成 reasoning_content，
        // max_tokens 过小时 content 为空，会把正常连接误判为失败
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const chatData = await chatRes.json().catch(() => ({}));
    const msg0 = chatData.choices?.[0]?.message || {};
    // content 或 reasoning_content 任一有内容即视为连通（HTTP 200 + choices 存在）
    const chatOk = chatRes.ok && !!chatData.choices?.length && !!(msg0.content || msg0.reasoning_content);

    // 连通后再查 API 余额（DeepSeek /user/balance；失败不阻断，只附注不可用）
    let balanceText = "";
    if (chatOk) {
      try {
        const balRes = await fetch(`${cfg.baseUrl}/user/balance`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (balRes.ok) {
          const bal = await balRes.json().catch(() => null);
          const balances = Array.isArray(bal?.balance_infos)
            ? bal.balance_infos.flatMap((info: { currency?: string; total_balance?: string }) => {
                if (typeof info.total_balance !== "string" || !info.total_balance.trim()) return [];
                const amount = Number(info.total_balance);
                if (!info.currency || !Number.isFinite(amount)) return [];
                const symbol = info.currency === "CNY" ? "¥" : info.currency === "USD" ? "$" : `${info.currency} `;
                return [`${symbol}${amount.toFixed(2)}`];
              })
            : [];
          if (balances.length) {
            // total_balance 已包含赠金和充值余额，不要再减 granted_balance。
            balanceText = ` · 余额 ${balances.join(" / ")}${bal?.is_available === false ? "（不可用）" : ""}`;
          } else {
            balanceText = " · 余额查询无数据";
          }
        } else {
          balanceText = ` · 余额查询失败（HTTP ${balRes.status}）`;
        }
      } catch {
        balanceText = " · 余额查询超时";
      }
    }

    return NextResponse.json({
      ok: chatOk,
      message: chatOk
        ? `连接成功 · 模型 ${cfg.model} 可用${balanceText}`
        : `连接失败（HTTP ${chatRes.status}）：${(chatData.error?.message || JSON.stringify(chatData).slice(0, 200) || "模型无响应内容")}`,
      models: modelIds,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      message: `无法连接 ${cfg.baseUrl}：${(e as Error).message}`,
    });
  }
}
