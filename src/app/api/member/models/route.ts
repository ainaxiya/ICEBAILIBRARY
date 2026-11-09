import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ─── v0.92 #10 会员中心模型列表：全部模型（计数）/ 按厂商分组（计数）+ 模型名称与功能 ───
// 只返回 status=online 的模型（后台已上线），功能 = endpointType + 已启用端点路径

const ENDPOINT_LABEL: Record<string, string> = {
  chat_completions: "对话补全",
  image_generations: "图像生成",
  video_generations: "视频生成",
  audio_generations: "音频生成",
  embeddings: "向量嵌入",
};

const TYPE_LABEL: Record<string, string> = {
  chat: "对话",
  image: "图像",
  video: "视频",
  audio: "音频",
};

export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [vendors, models] = await Promise.all([
    db.aiVendor.findMany({
      where: { status: "online" },
      orderBy: { id: "asc" },
      select: { id: true, name: true, slug: true },
    }),
    db.aiModel.findMany({
      where: { status: "online", vendor: { status: "online" } },
      orderBy: [{ vendorId: "asc" }, { id: "asc" }],
      select: {
        id: true,
        vendorId: true,
        name: true,
        displayName: true,
        endpointType: true,
        remark: true,
        endpoints: { where: { enabled: true }, select: { path: true } },
      },
    }),
  ]);

  const byVendor = vendors.map((v) => {
    const list = models
      .filter((m) => m.vendorId === v.id)
      .map((m) => ({
        id: m.id,
        name: m.name,
        displayName: m.displayName,
        type: TYPE_LABEL[m.endpointType] || m.endpointType,
        features: m.endpoints.map((e) => ENDPOINT_LABEL[e.path] || e.path),
        remark: m.remark,
      }));
    return { id: v.id, name: v.name, slug: v.slug, count: list.length, models: list };
  });

  return NextResponse.json({
    total: models.length,
    vendorCount: byVendor.length,
    vendors: byVendor,
  });
}
