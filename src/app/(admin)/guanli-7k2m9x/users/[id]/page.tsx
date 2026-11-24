import UserDetail from "@/components/admin/UserDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "会员详情" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserDetail userId={Number(id)} />;
}
