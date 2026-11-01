import SitePageView from "@/components/SitePageView";
import { getSitePage } from "@/lib/site-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "联系我们" };

export default async function ContactPage() {
  const page = await getSitePage("contact");
  return <SitePageView slug="contact" titleZh={page.title} html={page.content} />;
}
