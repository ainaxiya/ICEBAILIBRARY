-- ─── M5 生产库对齐（保守版，幂等可重复执行） ───
-- 执行位置：服务器上对生产库执行
-- 原则：实验场视频结算走上游实时报价（POST /v1/videos/quote），model_pricing 不参与结算；
--       但主站 /v1/videos 仍按 model_pricing 计费，故【不改动生产现有定价行】，
--       避免把 /v1 计费口径从「按秒估算」改成「按百万 token」引入不可控偏差。
-- 改动只有两类：
--   1) 端点：14 个已核实上游真实报价的文生/参考生视频模型，端点改 video_generations
--      （生产原为 image_generations，视频请求打不到正确接口）
--   2) 3 个无核实报价模型（上游目录取不到价的 open/10086 渠道）置 offline：
--      记录保留在库，实验场列表自动隐藏（video ready=端点+定价+online），/v1 也不可选。
--      将来补价启用步骤见《冰山AI实验场-开发方案-v2.md》§13.5。
-- 10 个 image-to-video（图生视频）模型本轮不接入，端点保持现状。

-- 1) 端点修正（按模型名，幂等）
UPDATE model_endpoint e
SET path = 'video_generations'
FROM ai_model m
JOIN ai_vendor v ON v.id = m."vendorId"
WHERE e."modelId" = m.id
  AND v."apiBase" LIKE '%teamorouter%'
  AND m."endpointType" = 'video'
  AND e.path = 'image_generations'
  AND m.name IN (
    'minimax-h3-text-to-video',
    'minimax-h3-reference-to-video',
    'minimax-h3-max-text-to-video',
    'minimax-h3-max-reference-to-video',
    'seedance-2-0-fast-text-to-video-basic',
    'seedance-2-0-fast-reference-to-video-basic',
    'seedance-2-0-mini-text-to-video-basic',
    'seedance-2-0-mini-reference-to-video-basic',
    'seedance-2-0-text-to-video-basic',
    'seedance-2-0-reference-to-video-basic',
    'seedance-2-5-text-to-video-basic',
    'seedance-2-5-reference-to-video-basic',
    'seedance-2-5-text-to-video-flex',
    'seedance-2-5-reference-to-video-flex'
  );

-- 2) 无核实报价模型置 offline（记录保留，实验场隐藏，补价后恢复 online 即启用）
UPDATE ai_model m
SET status = 'offline'
FROM ai_vendor v
WHERE v.id = m."vendorId"
  AND v."apiBase" LIKE '%teamorouter%'
  AND m."endpointType" = 'video'
  AND m.name IN (
    'seedance-2-0-10086-text-to-video',
    'seedance-2-0-10086-reference-to-video',
    'minimax-h3-open-text-to-video'
  );
