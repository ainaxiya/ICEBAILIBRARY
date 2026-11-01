import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { ensureCreditPacks, getBalance } from "@/lib/credits";
import { getServerLocale, translate as t } from "@/lib/i18n";
import RechargeClient from "@/components/RechargeClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "积分充值" };

export default async function RechargePage() {
  const locale = await getServerLocale();
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/recharge");

  await ensureCreditPacks();
  const [packs, balance] = await Promise.all([
    db.creditPack.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    getBalance(user.id),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-zinc-50">{t(locale, "recharge.title")}</h1>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2">
          <span className="text-xs text-zinc-500">{t(locale, "recharge.balance")}</span>
          <span className="ml-2 text-lg font-bold text-emerald-400">{Number(balance)}</span>
        </div>
      </div>
      <RechargeClient
        packs={packs.map((p) => ({
          packCode: p.packCode,
          priceCents: Number(p.priceCents),
          credits: Number(p.credits),
        }))}
      />
    </div>
  );
}
