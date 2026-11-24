import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { pricingJson } from "@/lib/model-json";
import { diffFields, withChanges, type AuditChange } from "@/lib/audit-diff";

export const dynamic = "force-dynamic";

// GET /api/admin/models/models/[id]/pricing —— 调价历史（按 effectiveAt 倒序）
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const modelId = Number(id);
  if (!Number.isInteger(modelId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const pricings = await db.modelPricing.findMany({
    where: { modelId },
    orderBy: { effectiveAt: "desc" },
  });
  return NextResponse.json({ pricings: pricings.map(pricingJson) });
}

const postSchema = z.object({
  meterBase: z.number().int().min(1).max(1_000_000_000).optional(),
  unit: z.enum(["token", "image", "video_second", "audio_second", "char", "request"]).optional(),
  inputPrice: z.number().min(0).max(1_000_000),
  outputPrice: z.number().min(0).max(1_000_000),
  currency: z.string().trim().max(10).optional(),
  fxRateE8: z.number().int().min(1).max(1_000_000_000_000).optional(),
  multiplierBps: z.number().int().min(1).max(100_000).optional(),
  // v0.96 直观定价：会员价按输入/输出直接填（积分/计量基数）
  memberInputPrice: z.number().min(0).max(1_000_000).nullable().optional(),
  memberOutputPrice: z.number().min(0).max(1_000_000).nullable().optional(),
  // 计费档位键：'' 通用；视频为 480p:n / 720p:n / 1080p:n / 4K:n / 720p:v
  variant: z.string().trim().max(20).optional(),
  effectiveAt: z.string().datetime().optional(),
});

const batchSchema = z.object({
  // 视频矩阵整组档位一次提交（最多 64 档，实际 ≤9）
  rows: z.array(postSchema).min(1).max(64),
});

type PricingInput = z.infer<typeof postSchema>;
type Tx = Prisma.TransactionClient;

// 审计日志「变更前后」字段（成本价/会员价/计量口径）
const PRICING_AUDIT_FIELDS = [
  "meterBase",
  "unit",
  "inputPrice",
  "outputPrice",
  "currency",
  "fxRateE8",
  "multiplierBps",
  "memberInputPrice",
  "memberOutputPrice",
] as const;
const PRICING_FIELD_LABELS: Record<string, string> = {
  meterBase: "计量基数",
  unit: "计费单位",
  inputPrice: "成本输入价",
  outputPrice: "成本输出价",
  currency: "币种",
  fxRateE8: "汇率(E8)",
  multiplierBps: "加价系数(bps)",
  memberInputPrice: "会员输入价",
  memberOutputPrice: "会员输出价",
};

// 单档位写入：同模型 + 同档位 + 同生效时刻 → 更新，否则插入（历史只增不改）
async function upsertPricing(tx: Tx, modelId: number, data: PricingInput, effectiveAt: Date) {
  const variant = data.variant ?? "";
  // 无历史行时沿用默认计量基数；有历史行默认继承上一行的计量口径（同档位优先）
  const prev =
    (await tx.modelPricing.findFirst({
      where: { modelId, variant },
      orderBy: { effectiveAt: "desc" },
    })) ??
    (await tx.modelPricing.findFirst({
      where: { modelId },
      orderBy: { effectiveAt: "desc" },
    }));

  const payload = {
    meterBase: data.meterBase ?? prev?.meterBase ?? 1_000_000,
    unit: data.unit ?? prev?.unit ?? "token",
    inputPrice: data.inputPrice,
    outputPrice: data.outputPrice,
    currency: data.currency || prev?.currency || "CNY",
    fxRateE8: BigInt(data.fxRateE8 ?? prev?.fxRateE8 ?? 100_000_000),
    multiplierBps: data.multiplierBps ?? prev?.multiplierBps ?? 150,
    memberInputPrice: data.memberInputPrice ?? null,
    memberOutputPrice: data.memberOutputPrice ?? null,
  };

  return {
    row: await tx.modelPricing.upsert({
      where: { modelId_variant_effectiveAt: { modelId, variant, effectiveAt } },
      create: { modelId, variant, effectiveAt, ...payload },
      update: payload,
    }),
    // 仅同档位的历史行才可作为「变更前」；跨档位继承值不算改动
    before: prev && prev.variant === variant ? prev : null,
  };
}

// POST /api/admin/models/models/[id]/pricing
// 单行：{ inputPrice, outputPrice, ... }；整组：{ rows: [{ variant, inputPrice, ... }] }
// 写入用 upsert：同模型同档位同生效时刻的重复提交不会撞唯一约束（幂等），不同时刻仍新增历史行
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const modelId = Number(id);
  if (!Number.isInteger(modelId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const body = await req.json().catch(() => null);

  const model = await db.aiModel.findUnique({ where: { id: modelId } });
  if (!model) return NextResponse.json({ error: "模型不存在" }, { status: 404 });

  // ─── 整组档位：单事务写入，任一失败全部回滚 ───
  if (body && Array.isArray((body as { rows?: unknown }).rows)) {
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
    }
    const rows = parsed.data.rows;
    const now = new Date();
    try {
      const saved = await db.$transaction(async (tx) => {
        const out = [];
        for (const row of rows) {
          out.push(
            await upsertPricing(tx, modelId, row, row.effectiveAt ? new Date(row.effectiveAt) : now)
          );
        }
        return out;
      });
      const changes: AuditChange[] = [];
      for (const s of saved) {
        const tag = s.row.variant || "默认档";
        for (const c of diffFields(s.before, s.row, PRICING_AUDIT_FIELDS, PRICING_FIELD_LABELS)) {
          changes.push({ ...c, field: `${tag}.${c.field}`, label: `${tag} ${c.label || c.field}` });
        }
      }
      await logAdminAction({
        adminId: admin.id,
        action: "create",
        targetType: "model_pricing",
        detail: withChanges(
          {
            modelId: model.id,
            model: model.name,
            batch: saved.length,
            variants: saved.map((s) => s.row.variant),
          },
          changes
        ),
        ip: await getClientIp(),
      });
      return NextResponse.json({ ok: true, count: saved.length, pricings: saved.map((s) => pricingJson(s.row)) });
    } catch (e) {
      console.error("pricing batch save failed:", e);
      return NextResponse.json({ error: "保存失败，未写入任何数据" }, { status: 500 });
    }
  }

  // ─── 单行（非视频单位 / 通用档） ───
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const data = parsed.data;
  try {
    const { row, before } = await upsertPricing(
      db,
      modelId,
      data,
      data.effectiveAt ? new Date(data.effectiveAt) : new Date()
    );
    await logAdminAction({
      adminId: admin.id,
      action: "create",
      targetType: "model_pricing",
      targetId: row.id,
      detail: withChanges(
        {
          modelId: model.id,
          model: model.name,
          inputPrice: data.inputPrice,
          outputPrice: data.outputPrice,
          multiplierBps: row.multiplierBps,
          effectiveAt: row.effectiveAt.toISOString(),
        },
        diffFields(before, row, PRICING_AUDIT_FIELDS, PRICING_FIELD_LABELS)
      ),
      ip: await getClientIp(),
    });
    return NextResponse.json({ ok: true, pricing: pricingJson(row) });
  } catch (e) {
    console.error("pricing save failed:", e);
    return NextResponse.json({ error: "保存失败，请稍后重试" }, { status: 500 });
  }
}
