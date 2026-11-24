import { NextResponse } from "next/server";
import { clearAdminAuthCookie, clearAdminReauthCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearAdminAuthCookie();
  await clearAdminReauthCookie();
  return NextResponse.json({ ok: true });
}
