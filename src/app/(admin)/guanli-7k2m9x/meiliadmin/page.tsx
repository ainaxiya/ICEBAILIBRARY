"use client";

import MeiliReindexToolbar from "@/components/admin/MeiliReindexToolbar";
import MeiliSearchManager from "@/components/admin/MeiliSearchManager";

// 搜索管理（原生版）：替代 meiliadmin 第三方 SPA iframe（插件与站点兼容性差，长期转圈）
// 功能全部用项目原生代码实现（走现有 /meiliadmin/proxy 服务端代理，Master Key 不下发）：
//   - 索引总览：三索引文档数 / 存储 / 索引状态
//   - 搜索测试：选索引 + 关键词实时搜索
//   - 文档浏览：分页查看索引文档
// 顶部保留「搜索数据全更新」工具条（全量重建 Meilisearch 索引）

export default function MeiliadminPage() {
  return (
    <div className="flex flex-col gap-3">
      <MeiliReindexToolbar />
      <MeiliSearchManager />
    </div>
  );
}