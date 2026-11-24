-- x3 用量 / 流水大表索引（keyset 分页友好 + 保留期清理）
-- 只定义、不执行：本文件不会自动运行，需人工审核后手动应用。
-- 手动执行请逐条运行（CREATE INDEX CONCURRENTLY 不能放在事务里），避免长时间锁写。
-- 注意：项目目前用 prisma db push 管理结构；若后续执行 db push，未写入 schema.prisma 的索引会被移除，
-- 因此文末附了对应的 @@index 声明，确认后再同步进 schema。

-- ─── usage_record ───

-- ① 保留期清理：WHERE "createdAt" < cutoff ORDER BY "createdAt", "id" LIMIT n
--    ② 后台消费报表：WHERE "createdAt" >= ? AND "createdAt" < ? GROUP BY date_trunc('day', "createdAt")
--    ③ 运营看板近 24h / 7d 汇总：WHERE "createdAt" >= now() - interval '...'
--    ④ 全站调用明细倒序分页：ORDER BY "createdAt" DESC, "id" DESC（btree 反向扫描）
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_usage_created_id"
  ON "usage_record" ("createdAt", "id");

-- 后台消费报表 channel=onsite|apikey 过滤后的时间范围查询 / 按日聚合
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_usage_channel_created"
  ON "usage_record" ("channel", "createdAt");

-- 会员用量明细：WHERE "userId" = ? AND channel = ? ORDER BY "createdAt" DESC, "id" DESC
-- 当前为 offset 分页，未来 keyset 形如 ("createdAt","id") < (?,?)；按日 / 按模型聚合可用该前缀
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_usage_user_channel_keyset"
  ON "usage_record" ("userId", "channel", "createdAt" DESC, "id" DESC);

-- ─── credit_ledger ───

-- ① 保留期清理：WHERE "createdAt" < cutoff ORDER BY "createdAt", "id" LIMIT n
--    ② 全站流水倒序分页（btree 反向扫描）
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ledger_created_id"
  ON "credit_ledger" ("createdAt", "id");

-- 会员流水 / 后台按 userId 筛选：WHERE "userId" = ? ORDER BY "createdAt" DESC, "id" DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ledger_user_keyset"
  ON "credit_ledger" ("userId", "createdAt" DESC, "id" DESC);

-- 后台流水按 reason 筛选（grant / consume / refund / admin_adjust）后倒序分页
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ledger_reason_keyset"
  ON "credit_ledger" ("reason", "createdAt" DESC, "id" DESC);

-- ─── 如需同步到 schema.prisma，对应声明如下（本轮不改 schema，避免 db push 顺带执行） ───
-- usage_record:
--   @@index([createdAt, id], map: "idx_usage_created_id")
--   @@index([channel, createdAt], map: "idx_usage_channel_created")
--   @@index([userId, channel, createdAt(sort: Desc), id(sort: Desc)], map: "idx_usage_user_channel_keyset")
-- credit_ledger:
--   @@index([createdAt, id], map: "idx_ledger_created_id")
--   @@index([userId, createdAt(sort: Desc), id(sort: Desc)], map: "idx_ledger_user_keyset")
--   @@index([reason, createdAt(sort: Desc), id(sort: Desc)], map: "idx_ledger_reason_keyset")
