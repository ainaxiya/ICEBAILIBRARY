import SitePageView from "@/components/SitePageView";
import { getSitePage } from "@/lib/site-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "关于我们" };

export default async function AboutPage() {
  const page = await getSitePage("about");
  return <SitePageView slug="about" titleZh={page.title} html={page.content} />;
}
