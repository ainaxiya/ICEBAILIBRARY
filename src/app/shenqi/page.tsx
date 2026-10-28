import type { Metadata } from "next";
import PromptOptimizer from "@/components/PromptOptimizer";
import { db } from "@/lib/db";
import { getPublicSite } from "@/lib/settings";

export const dynamic = "force-dynamic";

// 神器·全能提示词优化器 —— 独立单工具页（/shenqi）
// 仅渲染优化器工具区，无导航/搜索/页头/页脚（位于 (site) 路由组之外，
// 只继承根布局的最小文档壳），用于把神器打包成独立 APP / 单页应用。
export const metadata: Metadata = {
  title: "神器·全能提示词优化器",
  description: "把你的任意大白话，瞬间重构为全行业万能专业级提示词。",
};

export default async function ShenqiToolPage() {
  const [site, promptCount, skillCount] = await Promise.all([
    getPublicSite(),
    db.prompt.count({ where: { status: "published" } }),
    db.skill.count(),
  ]);

  return (
    <div className="site-theme min-h-screen">
      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <PromptOptimizer
          source="shenqi"
          siteName={site.siteName}
          promptCount={promptCount}
          skillCount={skillCount}
          rotatingLines={site.rotatingLines}
        />
      </main>
    </div>
  );
}
