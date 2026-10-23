import type { MetadataRoute } from "next";
import { db } from "@/lib/db";
import { skillHref } from "@/lib/skill-link";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const staticPages: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: "hourly", priority: 1 },
    { url: base + "/categories", changeFrequency: "daily", priority: 0.7 },
    { url: base + "/skills", changeFrequency: "daily", priority: 0.7 },
    { url: base + "/software", changeFrequency: "daily", priority: 0.7 },
    { url: base + "/search", changeFrequency: "daily", priority: 0.5 },
  ];
  try {
    const [prompts, skills, software] = await Promise.all([
      db.prompt.findMany({
        where: { status: "published" },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
        take: 20000,
      }),
      db.skill.findMany({
        where: { status: "published" },
        select: { id: true, slug: true, updatedAt: true },
        orderBy: { id: "asc" },
        take: 5000,
      }),
      db.software.findMany({
        where: { status: "published" },
        select: { slug: true, updatedAt: true },
        orderBy: { id: "asc" },
        take: 5000,
      }),
    ]);
    return [
      ...staticPages,
      ...prompts.map((p) => ({
        url: `${base}/p/${p.id}`,
        lastModified: p.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.8,
      })),
      ...skills.map((s) => ({
        url: base + skillHref(s.slug, s.id),
        lastModified: s.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
      ...software.map((s) => ({
        url: `${base}/software/${encodeURIComponent(s.slug)}`,
        lastModified: s.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
    ];
  } catch {
    return staticPages;
  }
}
