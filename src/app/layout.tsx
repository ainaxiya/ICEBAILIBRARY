import type { Metadata, Viewport } from "next";
import "./globals.css";
// 富文本编辑器本地样式（随应用打包，不依赖 CDN）
import "reactjs-tiptap-editor/style.css";
import { getPublicSite } from "@/lib/settings";
import RouteProgress from "@/components/RouteProgress";

export const dynamic = "force-dynamic";

// 禁止手机浏览器在输入框聚焦时自动放大页面（iOS焦点缩放）
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export async function generateMetadata(): Promise<Metadata> {
  const site = await getPublicSite();
  const titleDefault = `${site.siteName} - ${site.siteNameEn}`;
  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
    // 自引用 canonical：统一收敛到 siteUrl（www），避免 apex / www 双主机重复收录
    alternates: { canonical: "./" },
    title: {
      default: titleDefault,
      template: `%s | ${site.siteName}`,
    },
    description: site.description,
    keywords: site.keywords,
    // Bing 站长验证（msvalidate.01）
    other: {
      "msvalidate.01": "3C18526CAAF6F9910D2C2C1C841D8F73",
    },
    icons: {
      icon: site.favicon,
      apple: site.appleIcon,
      other: [
        { url: site.favicon32, sizes: "32x32", type: "image/png" },
        { url: site.icon192, sizes: "192x192", type: "image/png" },
        { url: site.appIcon, sizes: "512x512", type: "image/png" },
      ],
    },
    openGraph: {
      title: titleDefault,
      description: site.description,
      // 后台上传了自定义图标时优先用作分享图，否则用内置 og 图
      images: site.appIcon !== "/icon-512.png" ? [site.appIcon] : ["/og-image.png"],
      siteName: site.siteName,
    },
  };
}

// 根布局：仅最小文档壳。前台/后台各自使用路由组布局，互不嵌套。
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">
        <RouteProgress />
        {children}
      </body>
    </html>
  );
}
