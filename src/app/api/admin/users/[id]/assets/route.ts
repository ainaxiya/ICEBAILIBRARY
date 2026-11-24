import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { assetTypeLabel } from "@/lib/asset-types";
import { dateRangeFilter } from "@/lib/date-range";

export const dynamic = "force-dynamic";

// GET /api/admin/users/:id/assets?page=1&pageSize=20&dateFrom=&dateTo=
// 会员生成产物：服务端分页 + 时间区间筛选（dateTo 含当天）
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { ok } = await requirePerm(PERMISSIONS.USER_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id, 10);
  if (!Number.isInteger(uid) || uid <= 0) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") || "20") || 20));
  const range = dateRangeFilter(sp.get("dateFrom"), sp.get("dateTo"));

  const where = { userId: uid, ...(range ? { createdAt: range } : {}) };

  const [total, list] = await Promise.all([
    db.generatedAsset.count({ where }),
    db.generatedAsset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        assetType: true,
        mimeType: true,
        storageKey: true,
        sizeBytes: true,
        status: true,
        createdAt: true,
        expireAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    page,
    pageSize,
    total,
    assets: list.map((a) => ({
      id: String(a.id),
      assetType: a.assetType,
      typeLabel: assetTypeLabel(a.assetType),
      mimeType: a.mimeType,
      fileName: a.storageKey.split("/").pop() || a.storageKey,
      sizeBytes: Number(a.sizeBytes),
      status: a.status,
      createdAt: a.createdAt,
      expireAt: a.expireAt,
    })),
  });
}
