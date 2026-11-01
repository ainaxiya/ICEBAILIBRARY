# 数据库结构文档（v0.90）

> 与 `prisma/schema.prisma` 同步（PostgreSQL，Prisma 6 `db push` 无 migrations）。
> 连接：`127.0.0.1:35432`（Docker 容器 postgresql_18_kpJt 端口映射），库名 `prompthub`。
> 更新时间：2026-11-02（v0.90 会员积分与聚合网关系统落地）

## 表总览

| 表 | 用途 |
|---|---|
| User | 前台会员（含系统采集账号） |
| AdminAccount | 后台管理员（与会员完全隔离） |
| AdminRole | RBAC 角色与权限 |
| AdminLog | 后台操作日志（只增不改不删） |
| Category | 提示词分类（Prompt.category 存名称字符串，非外键） |
| Prompt | 提示词主体 |
| Like / Favorite | 点赞 / 收藏（后台统计用，前台已移除入口） |
| Comment / CommentLike | 通用多态评论（prompt / skill / software） |
| SiteSetting | 站点配置键值对（value 为 JSON 字符串） |
| TranslationCache | 自动翻译缓存 |
| CrawlItem / CrawlJob | 采集快照与异步入库任务 |
| SkillCategory / Skill | AI 技能分类与技能（SKILL.md） |
| SoftwareCategory / Software / SoftwareDownload | AI 软件三件套 |
| StorageBucket | 对象存储桶（MinIO / S3，SecretKey AES-256-GCM 加密） |
| OptimizerLog | 神器·全能提示词优化器使用记录（v0.85） |
| SitePage | 站务单页（help/about/contact/terms/privacy 固定白名单，v0.90） |
| AiVendor / VendorApiKey / AiModel / ModelEndpoint | 模型库四级结构：厂商 → 厂商 Key（密文）→ 模型 → 端点（v0.90） |
| KeyModelBinding / ModelPricing | Key-模型路由绑定（优先级/权重）与调价历史（v0.90） |
| UsageRecord | 网关调用日志（requestId 幂等，costMilli 毫积分 + paidCredits 整数积分，v0.90） |
| CreditPack / CreditGrant / CreditLedger | 积分包 / 积分授予（余额真源）/ 积分流水（只增，v0.90） |
| PayOrder / MemberPlan / UserSubscription | 充值订单 / 订阅计划 / 用户订阅（后两者表就绪暂不售卖，v0.90） |
| UserMessage / GeneratedAsset | 消息·工单（双向会话）/ 生成资产（30 天过期，v0.90） |
| UserApiKey | 站外会员 API Key（sha256 存储，明文一次性，v0.90） |
| OperationalAlert | 运营告警（积分池余额/毛利/单用户异常消耗，v0.90） |

## 核心表字段

### User（前台会员）
- 登录：`username`(unique) / `email` / `phone`（后两者可空 unique）、`passwordHash`
- `role`：`user`=会员、`importer`=采集系统账号（system，不可登录）、`admin_legacy`=历史管理员
- `membershipLevel` / `membershipUntil`：会员级别（界面不再展示，字段保留）
- `status`(active|banned)、`allowPublish`、`commentBanned`
- 防审计：`registerIp`、`lastLoginAt`、`lastLoginIp`

### AdminAccount（后台管理员）
- `username`(unique)、`passwordHash`、`status`(active|disabled)
- `isSuper`=true 全部权限；否则按 `adminRole.permissions`
- 与 User 无外键，Cookie 使用独立 `admin_token`

### Prompt（提示词）
- 内容：`title`、`content`(Text)、`description`(Text)、`tags String[]`
- 分类：`category String`（存中文分类名字符串，非外键）、`type`（文本创作/文生图/文生视频/文生音频）、`language`
- 媒体：`media Json` 数组 `MediaItem {type:"image"|"video"|"embed", url, poster?, role?:"cover"|"node", section?, nodeNo?, nodeKind?:"image"|"video", sourceUrl?, alt?}`；`coverUrl` 首图/封面
- 统计：`likeCount`/`favoriteCount`/`viewCount`/`commentCount`
- 来源：`sourceSite`（如 prompthub）、`sourceAuthor`、`sourceUrl`（采集条目为 null）
- 状态：`status`(draft|pending|published|rejected)、`rejectReason`、`commentsClosed`
- 时间：`createdAt`/`updatedAt`/`publishedAt`（发布时间独立，批量发布不动 publishedAt）
- 作者：`userId`→User（系统内容挂 system 账号）、`adminAuthorId`→AdminAccount
- 索引：(status, createdAt desc)、type、category、language、featured、hot、sourceUrl、adminAuthorId

### Comment / CommentLike（通用评论）
- 多态挂载：`targetType`(prompt|skill|software) + `targetId` 复合定位，主体删除不清理孤儿评论
- `parentId` 自关联两级回复；`status`(published|hidden|deleted)
- 审核取证 `ip`/`ua` 仅后台可见（前端 presentComment 白名单投影）
- 索引：(targetType, targetId, createdAt desc)、userId、parentId
- CommentLike：`@@unique([commentId, userId])` 防重复

### Skill（AI 技能）
- `slug` **允许重复**（v0.75 起无 unique 约束，URL 形式 `slug-id` 按 id 定位，旧纯 slug 链接兼容）
- `name`（中文翻译（英文原文））、`summary`（纯中文说明）、`skillMd`(Text，SKILL.md 英文原文)
- `files Json` 附加文件 `[{path, content, size}]`（打包 .zip 下载）
- `categoryId`→SkillCategory（2 字母短码：bc/wr/de/ma/da/au/re/os/pr）
- 统计：`viewCount`/`commentCount`/`copyCount`/`downloadCount`
- 发布者 `userId`→User（system 账号）

### Software / SoftwareDownload / StorageBucket（AI 软件）
- Software：`slug`(unique)、`name`、`version`、`tagline`、`description`(富文本 sanitize-html 净化)、`icon`(/uploads 本地路径)
- SoftwareDownload：`storageType`(local|bucket)；local→`fileUrl`(/uploads/soft/)，bucket→`bucketId`+`objectKey`（预签名 URL 下载）；`memberOnly` 会员门控
- StorageBucket：`type`(minio|s3)、`endpoint`（S3 须填区域完整域名）、`region`、`bucket`、`accessKey`、`secretKey`（`enc:v1:iv:tag:cipher` 加密不回显）、`publicBaseUrl`、`isDefault`、`enabled`

### CrawlItem / CrawlJob（采集）
- CrawlItem：`@@unique([source, remoteId])` 去重；`status`(new|collected|failed)；入库后 `promptId`/`skillId` 唯一外键关联
- CrawlJob：异步任务进度（total/done/succeeded/failed/lastError），前端轮询；`itemIds Int[]` 关联待采条目
- 孤儿任务自愈：重启后 running 状态自动标记中断

### SiteSetting（站点配置）
- `key`(pk) + `value`(JSON 字符串)，前台统一出口 `getPublicSite()`
- 保存接口 zod 白名单必须含新增字段（friendLinks、bannerPc、bannerMobile…），否则静默丢弃

### OptimizerLog（优化器使用记录，v0.85）
- 每次前台调用 `/api/optimize` 写一条：`ip` + `input`(用户提交) + `output`(优化结果) + `error`(出错内容，成功为空)
- **不关联用户账号**（登录会员也不记录账号），仅供后台「优化器使用记录」页查看
- 后台列表 20 条/页，`createdAt desc` 排序；索引 `(createdAt)`
- 写入为 fire-and-forget（`.catch(()=>{})`），不阻塞优化响应

## v0.90 新增表（会员积分与聚合网关）

### SitePage（站务单页）
- `slug` 主键固定白名单：help / about / contact / terms / privacy；`content` 富文本 HTML（sanitize 净化），后台可视化编辑

### AiVendor / VendorApiKey / AiModel / ModelEndpoint（模型库四级）
- AiVendor：`slug` 标识、`apiBase` 上游地址、`protocol`(openai)、`status`(online|deprecated|offline)
- VendorApiKey：`keyCipher` 密文（`enc:v1:iv:tag:cipher`）**不回显**，`keyPrefix` 明文前缀仅识别用
- AiModel：`@@unique([vendorId, name])`，`endpointType`(chat|image|video|audio)；ModelEndpoint：`path` + `@@unique([modelId, path])`

### KeyModelBinding / ModelPricing（路由与计费真源）
- KeyModelBinding：`@@unique([apiKeyId, modelId])`，路由按 `priority` 小值优先、同级按 `weight`，失败降级换 Key ≤3 次
- ModelPricing 调价历史：多行按 `effectiveAt` 取最新生效；成本换算（毫积分）= 计量值×单价×`fxRateE8`/1e8×100积分/元×1000毫/积分÷`meterBase`，标价 = ceil(成本×`multiplierBps`/10000)

### UsageRecord（网关调用日志）
- `requestId` 唯一幂等；`costMilli` 内部成本（毫积分，毛利报表）、`paidCredits` 用户实扣整数积分（ceil 最低 1 分）
- `channel`(onsite|apikey)、`modelSnapshot` 调用时点模型名快照、`status`(success|failed|blocked)

### CreditPack / CreditGrant / CreditLedger / PayOrder（积分闭环）
- CreditGrant 为**余额真源**：余额 = 有效 grant 的 `remainingCredits` 之和；`@@unique([userId, grantType, sourceRef])` 幂等；消费按 `expiresAt` 先过期先扣（NULLS LAST）
- CreditLedger 只增不改，`requestId` 唯一幂等；`changeAmount` 正=入账负=扣减，`reason`(grant|consume|refund|admin_adjust)
- PayOrder：`orderNo` 对外幂等、`providerEventId` 回调幂等、`channel`(wechat|alipay|custom|stripe|crypto)、`amountCents` 人民币分
- 计费语义（`src/lib/gateway/billing.ts`）：预扣 est → 结算退差/补扣（总扣分封顶 est×3）→ 失败整数退回；<200 积分禁生图/生视频

### MemberPlan / UserSubscription（订阅，表就绪暂不售卖）

### UserMessage / GeneratedAsset / UserApiKey / OperationalAlert（用户中心与运营）
- UserMessage 双向合一：`direction`(user_to_admin|admin_to_user)、会话 = 根消息 + `replyToId` 回复串、`ticketStatus` 维护在根消息（open|replied|closed）、`batchId` 群发批次、`readAt` 未读判定
- GeneratedAsset：`status`(temp|deleted)、`expireAt` 默认创建后 30 天、转存路径 `generated/{uid}/{yymm}/{uuid}.{ext}`，`sourceUrl` 仅转存失败留存供重试
- UserApiKey：明文 `sk-` 创建时一次性返回，库内只存 `keyHash`(sha256 unique) + `keyPrefix`
- OperationalAlert：`alertType`(credit_pool|gross_margin|user_burst)、`payload` 巡检快照 JSON、`ackAt` 确认标记

## 设计约定

1. 分类字符串/多态外键/软状态字段是本项目风格：加新栏目不动表结构（评论多态、Prompt.category 字符串）
2. 统计字段冗余存储，避免实时 COUNT；浏览量自增用原生 SQL 不动 `updatedAt`
3. 密钥类（StorageBucket.secretKey、JWT、Meili key）不进日志不回显
4. 时间字段一律 UTC 存储，后台显示走浏览器本地时区
