-- ─── m6：Seedance 2.x 视频档位价（按秒计费，幂等可重复执行） ───
-- 口径（与用户确认）：
--   1) unit=video_second、meterBase=1，inputPrice = 官方「元/秒」，outputPrice=0；
--   2) 加价系数 1.66（multiplierBps=16600），积分 = ceil(元/秒 × 166 × 时长)；
--   3) 档位键 variant = `<分辨率>:<n|v>`，n=输入不含视频，v=输入包含视频；
--   4) 不含视频取官方「元/个 ÷ 5 秒」；
--      含视频取官方区间「最高价 ÷ 5 秒」（即输入视频按上限 30s/15s 计，不足也按上限，
--      与用户确认口径一致：不做区间插值、不用 token 公式推算）；
--   5) 幂等：固定 effectiveAt='2026-11-17 00:00:00+08'，重复执行走 ON CONFLICT DO UPDATE，
--      不会堆出重复行，也不会改动同模型其它 effectiveAt 的历史价。
--
-- 官方来源：https://ark.volcengine.com/region:cn-beijing/docs/model-pricing
--   「视频生成模型 → 价格示例」（2026-11-17 版，16:9、输出 5 秒）
--   Seedance 2.5   不含视频：480p 3.36 / 720p 7.56 / 1080p 18.71 / 4K 30.13 元/个
--                  含视频（输入 2~30s）：480p 3.63~14.12 / 720p 8.16~31.75 /
--                                            1080p 20.12~78.25 / 4K 33.24~129.28 元/个
--   Seedance 2.5-flash 不含视频：480p 2.21 / 720p 4.97 元/个
--                  含视频（输入 2~30s）：480p 2.42~9.42 / 720p 5.44~21.17 元/个
--   Seedance 2.0   不含视频：480p 2.31 / 720p 4.97 / 1080p 12.39 / 4K 25.27 元/个
--                  含视频（输入 2~15s）：480p 2.53~5.62 / 720p 5.44~12.10 /
--                                            1080p 13.56~30.13 / 4K 27.99~62.21 元/个
--   Seedance 2.0-fast  不含视频：480p 1.86 / 720p 4.00 元/个
--                  含视频（输入 2~15s）：480p 1.99~4.42 / 720p 4.28~9.50 元/个
--   Seedance 2.0-mini  不含视频：480p 1.16 / 720p 2.48 元/个
--                  含视频（输入 2~15s）：480p 1.27~2.81 / 720p 2.72~6.05 元/个
--
-- 执行方式：
--   本文件不含 BEGIN/COMMIT（便于脚本先跑后回滚预览）。
--   手工：psql -1 -f prisma/m6-video-variant-pricing-prod.sql
--   脚本：node scripts/apply-video-variant-pricing.mjs [--db <url>] [--apply]
--   执行前请备份 model_pricing。

CREATE TEMP TABLE seedance_variant_price (
  model_name    TEXT,
  resolution    TEXT,
  has_video     BOOLEAN,
  price_per_sec NUMERIC(18, 8)
) ON COMMIT DROP;

INSERT INTO seedance_variant_price (model_name, resolution, has_video, price_per_sec) VALUES
  -- Doubao-Seedance-2.5
  ('doubao-seedance-2-5-260628',        '480p',  false, 0.672),
  ('doubao-seedance-2-5-260628',        '720p',  false, 1.512),
  ('doubao-seedance-2-5-260628',        '1080p', false, 3.742),
  ('doubao-seedance-2-5-260628',        '4K',    false, 6.026),
  ('doubao-seedance-2-5-260628',        '480p',  true,  2.824),
  ('doubao-seedance-2-5-260628',        '720p',  true,  6.350),
  ('doubao-seedance-2-5-260628',        '1080p', true,  15.650),
  ('doubao-seedance-2-5-260628',        '4K',    true,  25.856),
  -- Doubao-Seedance-2.5-flash
  ('doubao-seedance-2-5-flash-261115',  '480p',  false, 0.442),
  ('doubao-seedance-2-5-flash-261115',  '720p',  false, 0.994),
  ('doubao-seedance-2-5-flash-261115',  '480p',  true,  1.884),
  ('doubao-seedance-2-5-flash-261115',  '720p',  true,  4.234),
  -- Doubao-Seedance-2.0
  ('doubao-seedance-2-0-260128',        '480p',  false, 0.462),
  ('doubao-seedance-2-0-260128',        '720p',  false, 0.994),
  ('doubao-seedance-2-0-260128',        '1080p', false, 2.478),
  ('doubao-seedance-2-0-260128',        '4K',    false, 5.054),
  ('doubao-seedance-2-0-260128',        '480p',  true,  1.124),
  ('doubao-seedance-2-0-260128',        '720p',  true,  2.42),
  ('doubao-seedance-2-0-260128',        '1080p', true,  6.026),
  ('doubao-seedance-2-0-260128',        '4K',    true,  12.442),
  -- Doubao-Seedance-2.0-fast
  ('doubao-seedance-2-0-fast-260128',   '480p',  false, 0.372),
  ('doubao-seedance-2-0-fast-260128',   '720p',  false, 0.800),
  ('doubao-seedance-2-0-fast-260128',   '480p',  true,  0.884),
  ('doubao-seedance-2-0-fast-260128',   '720p',  true,  1.90),
  -- Doubao-Seedance-2.0-mini
  ('doubao-seedance-2-0-mini-260615',   '480p',  false, 0.232),
  ('doubao-seedance-2-0-mini-260615',   '720p',  false, 0.496),
  ('doubao-seedance-2-0-mini-260615',   '480p',  true,  0.562),
  ('doubao-seedance-2-0-mini-260615',   '720p',  true,  1.21);

-- 只动火山厂商（vendorId=3）下按名字精确匹配的 5 个模型，其余一律不碰
INSERT INTO model_pricing (
  "modelId", "meterBase", unit, "inputPrice", "outputPrice",
  currency, "fxRateE8", "multiplierBps", variant, "effectiveAt"
)
SELECT
  m.id,
  1,
  'video_second',
  s.price_per_sec,
  0,
  'CNY',
  100000000,
  16600,
  s.resolution || CASE WHEN s.has_video THEN ':v' ELSE ':n' END,
  TIMESTAMPTZ '2026-11-17 00:00:00+08'
FROM seedance_variant_price s
JOIN ai_model m
  ON m.name = s.model_name
 AND m."vendorId" = 3
ON CONFLICT ("modelId", variant, "effectiveAt") DO UPDATE
SET "meterBase"     = EXCLUDED."meterBase",
    unit            = EXCLUDED.unit,
    "inputPrice"    = EXCLUDED."inputPrice",
    "outputPrice"   = EXCLUDED."outputPrice",
    currency        = EXCLUDED.currency,
    "fxRateE8"      = EXCLUDED."fxRateE8",
    "multiplierBps" = EXCLUDED."multiplierBps";
