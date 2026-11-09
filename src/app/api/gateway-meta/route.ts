import { NextResponse } from "next/server";
import { getGatewayRoutes, hostnamesOfRoutes } from "@/lib/gateway/gateway-routes";

export const dynamic = "force-dynamic";

// ─── v0.92：网关域名元数据（middleware 专用，公开只读） ───
// 返回后台「多线路 Base URL」的域名集合，供 middleware 判断 API 网关域名。
// 只暴露域名，不暴露线路名称/完整 URL。

let cache: { hosts: string[]; at: number } | null = null;
const CACHE_MS = 30_000;

export async function GET() {
  if (!cache || Date.now() - cache.at >= CACHE_MS) {
    cache = { hosts: hostnamesOfRoutes(await getGatewayRoutes()), at: Date.now() };
  }
  return NextResponse.json({ hosts: cache.hosts });
}
