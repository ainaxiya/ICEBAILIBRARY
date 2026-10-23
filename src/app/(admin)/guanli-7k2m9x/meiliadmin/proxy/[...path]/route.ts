import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { ADMIN_BASE } from "@/lib/admin-path";

// ─── 搜索管理 · MeiliSearch 同源代理 ───
// /meiliadmin/proxy/* → MEILI_HOST，服务端注入 Authorization: Bearer MEILI_MASTER_KEY
// Master Key 只留在服务端，不下发浏览器

export const dynamic = "force-dynamic";

async function proxy(req: NextRequest, rest: string[]) {
  const host = (process.env.MEILI_HOST || "http://127.0.0.1:7700").replace(/\/+$/, "");
  const key = process.env.MEILI_MASTER_KEY || "";
  const qs = req.nextUrl.search;
  const target = `${host}/${rest.map(encodeURIComponent).join("/")}${qs}`;
  const headers: Record<string, string> = {};
  const ct = req.headers.get("content-type");
  if (ct) headers["Content-Type"] = ct;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
  try {
    const res = await fetch(target, { method, headers, body, cache: "no-store" });
    const outHeaders: Record<string, string> = {
      "Content-Type": res.headers.get("content-type") || "application/json",
      "X-Content-Type-Options": "nosniff",
    };
    return new Response(res.body, { status: res.status, headers: outHeaders });
  } catch {
    return Response.json({ message: "MeiliSearch unreachable" }, { status: 502 });
  }
}

async function handler(req: NextRequest, rest: string[]) {
  const admin = await requireAdmin();
  if (!admin) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${ADMIN_BASE}/login?next=${encodeURIComponent(ADMIN_BASE + "/meiliadmin")}` },
    });
  }
  return proxy(req, rest);
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return handler(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return handler(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return handler(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return handler(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return handler(req, (await ctx.params).path);
}
