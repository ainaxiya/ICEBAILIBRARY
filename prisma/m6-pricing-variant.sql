-- m6：model_pricing 增加计费档位键（方案 A：按分辨率 × 是否含视频输入拆多行）
-- 只做结构变更，不写入任何价格数据。执行前请备份 model_pricing。
--
-- 档位取值约定：
--   视频：480p:n / 720p:n / 1080p:n / 4K:n / 720p:v（n=输入不含视频，v=输入含视频）
--   其它：''（空字符串 = 通用/兜底）
--
-- 兼容性：老行自动获得 variant='' 默认值，取价逻辑在找不到精确档位时回退到 ''，因此无需回填。

BEGIN;

ALTER TABLE "model_pricing"
  ADD COLUMN IF NOT EXISTS "variant" TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS "model_pricing_modelId_variant_effectiveAt_key"
  ON "model_pricing" ("modelId", "variant", "effectiveAt");

COMMIT;
