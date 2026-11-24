import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getActiveUser } from "@/lib/auth";
import { prepareSkillMaterial } from "@/lib/playground/safety";
import { getPlaygroundEnabled } from "@/lib/playground/settings";

export const dynamic = "force-dynamic";

// ─── 冰山实验场 M3：技能运行（素材准备） ───
// 「运行技能」在本期等于「把技能正文安全地作为 system 素材注入对话」，不执行工具、不跑外部命令。
// 白名单、注入中和、隐私脱敏都在服务端完成；前端拿到的是包裹后的素材与安全报告。

const bodySchema = z.object({
  skillId: z.number().int().positive(),
});

export async function POST(req: Request) {
  // pa1 实验场总开关：关闭后技能运行接口一律拒绝
  if ((await getPlaygroundEnabled()) === false) {
    return NextResponse.json({ error: "实验场已关闭", code: "playground_closed" }, { status: 403 });
  }
  const { user, state } = await getActiveUser();
  if (!user) {
    return state === "suspended"
      ? NextResponse.json(
          { error: "账号已被封禁，无法使用实验场", code: "account_suspended" },
          { status: 403 }
        )
      : NextResponse.json(
          { error: "请先登录后再使用实验场", code: "not_authenticated" },
          { status: 401 }
        );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请求参数不合法", code: "invalid_body" }, { status: 400 });
  }

  const skill = await db.skill.findUnique({
    where: { id: parsed.data.skillId },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      featured: true,
      skillMd: true,
      summary: true,
    },
  });
  if (!skill) {
    return NextResponse.json({ error: "技能不存在", code: "skill_not_found" }, { status: 404 });
  }

  const built = prepareSkillMaterial(skill);
  if (!built.ok) {
    return NextResponse.json(
      { error: `技能「${skill.name}」暂不能在实验场运行：${built.reason}`, code: "skill_not_whitelisted" },
      { status: 403 }
    );
  }

  return NextResponse.json({
    skill: { id: skill.id, name: skill.name, slug: skill.slug, summary: skill.summary },
    material: built.material,
    report: built.report,
  });
}
