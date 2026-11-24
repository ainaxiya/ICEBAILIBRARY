import { db } from "@/lib/db";

export const revalidate = 3600;

// ─── sitemap 瘦身（v0.97）：全站总量控制在 1 万~2 万条 ───
// 索引顺序 = 收录优先级：栏目页/静态页(static) → 精选(featured) → 提示词(prompts-N) → 技能(skills-N)
// v0.117 AI 软件下线：不再输出 software 分片（旧 URL 已 301 到 /playground）
// 分片 5000 条/片（远低于单文件 5 万条 / 10MB 上限）；域名统一取 NEXT_PUBLIC_SITE_URL
const CHUNK = 5000;
const PROMPT_CAP = 10000;
const SKILL_CAP = 5000;

// sitemap index：按类型/ID 段分片
export async function GET() {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  const [promptCount, skillCount, featuredPromptCount, featuredSkillCount] = await Promise.all([
    db.prompt.count({ where: { status: "published", featured: false } }),
    db.skill.count({ where: { status: "published", featured: false } }),
    db.prompt.count({ where: { status: "published", featured: true } }),
    db.skill.count({ where: { status: "published", featured: true } }),
  ]);
  const names = ["static"];
  if (featuredPromptCount + featuredSkillCount > 0) names.push("featured");
  for (let i = 0; i < Math.ceil(Math.min(promptCount, PROMPT_CAP) / CHUNK); i++) names.push(`prompts-${i}`);
  for (let i = 0; i < Math.ceil(Math.min(skillCount, SKILL_CAP) / CHUNK); i++) names.push(`skills-${i}`);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...names.map((n) => `  <sitemap><loc>${base}/sitemaps/${n}.xml</loc></sitemap>`),
    "</sitemapindex>",
  ].join("\n");
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
