import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import ProfileSettings from "@/components/member/ProfileSettings";

export const dynamic = "force-dynamic";

export const metadata = { title: "我的资料", robots: { index: false, follow: true } };

// 会员资料独立页：完整资料 + 头像真实上传（不走弹层，避免装不下）
export default async function ProfilePage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login?next=/user/profile");

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">我的资料</h1>
          <p className="mt-1 text-sm text-zinc-500">头像、联系方式和个人档案都在这里维护</p>
        </div>
        <Link
          href="/member"
          className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500"
        >
          返回会员中心
        </Link>
      </div>

      <ProfileSettings />
    </div>
  );
}
