import { permanentRedirect } from "next/navigation";

// v0.117 AI 软件栏目下线：详情页 301 到实验场占位页（保 SEO 收录迁移）
export const dynamic = "force-dynamic";

export default async function SoftwareDetailGone({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await params;
  permanentRedirect("/playground");
}
