-- ─── 首帧链路发版 SQL（幂等，可重复执行；本次不执行，跟下次发版一起走） ───
-- 目标模型：seedance-2-0-image-to-video-basic
-- 只改这一条模型记录，不动其它图生视频模型（它们还没有核实报价，等实测后再逐个接入）。
--
-- 为什么需要三处改动（缺一不可）：
--   1) ai_model."endpointType"：实验场按模型类型分组，任务接口也校验 kind 与 endpointType 一致；
--      该模型当前是 image，视频任务会被 400 kind_mismatch 拒绝。
--   2) model_endpoint.path = video_generations：视频请求走 /v1/videos，端点不对会打错上游接口。
--   3) model_pricing：实验场列表的 ready = 端点 + 定价 + online；没有定价行会被列表过滤掉。
--      视频结算本身走上游实时报价，这一行只提供汇率/加价系数与列表展示。
-- 执行前建议：SELECT 备份该模型三张表的现有行（ai_model / model_endpoint / model_pricing）。

BEGIN;

-- 1) 模型类型改 video（按模型名精确匹配）
UPDATE ai_model
SET "endpointType" = 'video',
    status = 'online',
    "updatedAt" = now()
WHERE name = 'seedance-2-0-image-to-video-basic';

-- 2) 端点：确保 video_generations 存在且启用（保留原 image_generations 行不动）
INSERT INTO model_endpoint ("modelId", path, enabled, "createdAt")
SELECT m.id, 'video_generations', true, now()
FROM ai_model m
WHERE m.name = 'seedance-2-0-image-to-video-basic'
ON CONFLICT ("modelId", path) DO UPDATE SET enabled = true;

-- 3) 定价：仅在完全没有定价行时补一行（已有定价不覆盖）
INSERT INTO model_pricing
  ("modelId", "meterBase", unit, "inputPrice", "outputPrice", currency, "fxRateE8", "multiplierBps", "effectiveAt", "createdAt")
SELECT m.id, 1, 'video_second', 0, 0, 'USD', 668000000, 15000, now(), now()
FROM ai_model m
WHERE m.name = 'seedance-2-0-image-to-video-basic'
  AND NOT EXISTS (SELECT 1 FROM model_pricing p WHERE p."modelId" = m.id);

COMMIT;

-- 回滚（发版后如需撤回）：
-- DELETE FROM model_endpoint WHERE "modelId" = (SELECT id FROM ai_model WHERE name = 'seedance-2-0-image-to-video-basic') AND path = 'video_generations';
-- UPDATE ai_model SET "endpointType" = 'image' WHERE name = 'seedance-2-0-image-to-video-basic';
-- （定价行若为本次新增可一并删除；已有定价行不受影响）
