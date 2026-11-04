import { getServerLocale, translate as t } from "@/lib/i18n";
import ApiDocsContent from "@/components/ApiDocsContent";

export const dynamic = "force-dynamic";
export const metadata = { title: "API 接口文档" };

// ─── 站外 API 接口帮助文档（聚合网关，OpenAI 兼容） ───
// 左右分栏：左侧粘性锚点目录（ApiDocsTocNav，IntersectionObserver 高亮），右侧文档正文。
// 文档主体（目录 + 正文 + 模型目录表查库逻辑）抽取至 ApiDocsContent，后台「API 文档」页共用同一份内容。

export default async function ApiDocsPage() {
  const locale = await getServerLocale();

  return (
    <div>
      <div className="mb-8">
        <h1 className="mb-2 text-2xl font-bold text-zinc-100">{t(locale, "page.apiDocs.title")}</h1>
        <p className="text-sm text-zinc-400">
          本站聚合网关提供 OpenAI 兼容的大模型调用接口，可用于站外应用接入或自有工具调用。本文档面向站外开发者，涵盖认证、模型选择、对话 / 图像 / 视频接口、计费规则、限流配额、错误码、调用示例与常见问题。
        </p>
      </div>

      <ApiDocsContent />
    </div>
  );
}
