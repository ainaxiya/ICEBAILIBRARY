import SitePageView from "@/components/SitePageView";
import { getSitePage } from "@/lib/site-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "使用帮助" };

export default async function HelpPage() {
  const page = await getSitePage("help");
  return <SitePageView slug="help" titleZh={page.title} html={page.content} />;
}
