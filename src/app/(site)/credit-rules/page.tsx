import SitePageView from "@/components/SitePageView";
import { getSitePage } from "@/lib/site-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "积分规则" };

// 积分规则单页：内容由后台「单页内容管理」编辑；该路由在 layout 中不渲染站点页脚
export default async function CreditRulesPage() {
  const page = await getSitePage("credit-rules");
  return <SitePageView slug="credit-rules" titleZh={page.title} html={page.content} />;
}
