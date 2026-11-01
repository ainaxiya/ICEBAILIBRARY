import SitePageView from "@/components/SitePageView";
import { getSitePage } from "@/lib/site-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "隐私政策" };

export default async function PrivacyPage() {
  const page = await getSitePage("privacy");
  return <SitePageView slug="privacy" titleZh={page.title} html={page.content} />;
}
