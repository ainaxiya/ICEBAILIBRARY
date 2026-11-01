import SitePageView from "@/components/SitePageView";
import { getSitePage } from "@/lib/site-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "服务条款" };

export default async function TermsPage() {
  const page = await getSitePage("terms");
  return <SitePageView slug="terms" titleZh={page.title} html={page.content} />;
}
