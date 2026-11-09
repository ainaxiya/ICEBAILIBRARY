# 冰山AI资料库 Iceberg AI Library（v0.93.2）

原「完整提示词 CompletePrompt」升级版。收集、分享、发现优质 AI 提示词 / AI 技能 / AI 软件的资料库网站。内置 20000+ 条真实创作过程提示词（图片/视频/音频/文本）与 600+ 条 AI 技能（SKILL.md），其中大量条目含与提示词分段精确对应的实拍效果图与视频截图，全部本地化存储。

## 图片展示

- 在线演示：https://www.icebai.com（备用域名：https://www.wango8.com）
- PC 端截图：![PC.png](https://github.com/ainaxiya/CompletePrompt/blob/master/PC.png)
- 手机端截图：![mobile.png](https://github.com/ainaxiya/CompletePrompt/blob/master/mobile.png)
- 后台截图：![caiji.png](https://github.com/ainaxiya/CompletePrompt/blob/master/caiji.png)

## 功能介绍

### 前台
- **四大栏目**：首页 / 提示词 / AI 技能 / AI 软件（桌面顶部导航 + 手机底部 Tab）
- **提示词浏览**：首页「神器·全能提示词优化器」+ 精选流 / 分类浏览（2 字母短码路由）/ 按创作类型浏览（文本/文生图/文生视频/文生音频）/ 标签筛选
- **AI 技能**：SKILL.md 技能文件集合站，分类侧栏 + 排序搜索，详情页一键 Copy / Download（含附加文件自动打包 .zip），复制数会话级防抖统计
- **AI 软件**：macwk 风格图标卡片，详情页多下载条目（本站文件 / 对象存储 60 秒预签名直链），会员门控下载，下载量统计
- **详情页**：分段提示词（`[N] 标签｜…｜节点名`）与图片/视频截图精确对应、一键复制；栏目与类型可点链接；自动中英翻译
- **混合搜索**：GitHub 风格整页搜索，左侧「全部/提示词/技能/软件」单选筛选树 + 右侧行式结果列表，相关度 / 最新双排序，Meilisearch 三索引一次查询合并
- **用户系统**：注册登录（独立 JWT，HttpOnly Cookie）、个人中心、发布提示词；注册字段后台可配
- **评论系统**：两级嵌套回复、评论点赞、限频验证码防刷、敏感词屏蔽、单篇关评；评论通用化支持提示词/技能/软件
- **会员体系**：free / Pro / VIP 三级，权益与价格后台可配置；软件下载可设会员专享
- **会员积分与聚合网关（v0.90）**：整数积分计费（ceil 取整、预扣/结算/封顶退补），OpenAI 兼容聚合网关 `/v1/chat/completions`（SSE 流式透传）与 `/v1/images/generations`，站内会员与 `sk-` API Key 双通道鉴权；充值（积分包/会员订阅/支付单）、用量明细、生成产物转存（默认桶 30 天生命周期）
- **用户中心（v0.90）**：余额/充值/积分流水/用量记录/生成资产/消息工单/API Key 管理六大板块
- **站务单页（v0.90）**：帮助/关于/联系/服务条款/隐私政策 5 单页 + API 文档页，后台可视化编辑，Footer 三列导航
- **响应式**：PC / 平板 / 手机三档自适应；手机端底部 Tab 导航，适配 iPhone 安全区
- **页脚友情链接**：后台配置，前台 copyright 上方一排小字展示

### 后台管理（隐蔽入口 `/guanli-7k2m9x`）
- 独立管理员体系（AdminAccount 与会员表完全隔离）、RBAC 多角色细粒度权限、操作日志只增不可改
- 仪表盘、提示词管理（全字段可编辑）、用户管理、评论管理（类型筛选 + 无主评论清理）、标签管理、分类管理
- **技能管理**：技能分类（2 字母短码）+ 技能 CRUD（SKILL.md / 附加文件 / 标签 / 多语言）
- **软件管理**：软件分类 + 软件 CRUD（图标外链自动本地化 + 下载子表：本站文件 / 存储桶对象键 / 体积 / 会员门控）
- **存储桶设置**：S3 / MinIO 多桶管理，SecretKey AES-256-GCM 加密存储不回显，HeadBucket + ListObjects 一键测试连接，默认桶唯一
- 网站设置：站点信息 / SEO 关键字 / 页脚文字 / LOGO 与图标上传 / 神器·全能提示词优化器（DeepSeek API Key + 连接测试 + 优化技能文档可编辑）/ 友情链接 / Meili 同步间隔
- **Sitemaps 提交**：设置页一键把 `sitemap.xml` 推送给搜索引擎，提交前自动自检 sitemap 可达性与 URL 条数，记录提交时间与各引擎 HTTP 状态（Google / Bing 官方已停止 ping 接口，页内附 Search Console 直达入口）
- **搜索管理**：内嵌 Meiliadmin v1.4.0（`/guanli-7k2m9x/meiliadmin`），Tag 标签管理下方直达，免登录预认证进入索引 / 任务 / 密钥 / 转储管理；API 走同源代理由服务端注入鉴权头，Master Key 不下发浏览器
- **模型库管理（v0.90）**：厂商 → 厂商 Key → 模型 → 端点四级结构，Key 密文存储（`enc:v1:` AES-GCM）明文只进不出，Key-模型绑定（优先级/权重路由、失败降级换 Key ≤3 次），调价历史（fxRateE8 / multiplierBps / meterBase 成本换算）
- **运营完善（v0.90）**：用量成本报表、积分包配置、消息群发/工单、支付渠道配置（微信/支付宝/自定义/Stripe/加密货币 adapter）、运营告警看板、站点单页编辑

## 一键采集

- 支持 **4 个数据源**：LibLib TV、即梦AI、**PromptHub 技能库**（`prompthub.xin/skills`）、**PromptHub 提示词库**（`prompthub.xin/prompts`）
- 后台「采集管理」一键获取更新，自动去重，勾选或全部采集入库；后台异步任务 + 进度轮询，入库即上 Meili 索引；采集权限点 `crawl:manage` 可按角色分配
- **LibLib TV / 即梦AI**：自动拉取作品提示词全文、封面、节点图片与视频截图（sharp webp 化 + ffmpeg 截帧，全部本地化）；即梦视频作品正确解析 `text2video_params.video_gen_inputs.prompt`；空标题自动取提示词前 30 字兜底
- **PromptHub 技能库**：列表页从 JSON-LD canonical URL 提取 slug，详情页解析 GitHub 来源路径后直连 `raw.githubusercontent.com` 拉取 **SKILL.md 全文**（自动探测默认分支），无需登录、不受站点客户端渲染影响
- **PromptHub 提示词库**：列表页从 `<a href="/prompts/">` 提取条目，详情页从 RSC payload `search_text` 提取提示词全文（绕开列表/详情 API 的 100 字截断），图片全部本地化
- 采集条目**不保存原网址**（`sourceUrl = null`），统一走「原始分类 → 站内分类」自动映射（技能映射到 10 个 SkillCategory 短码，提示词映射到 Prompt 分类）
- 待采列表支持批量删除（下次获取重进）与批量/单条「不采集」（永久跳过）；失败条目进「采集失败」Tab 可重试

## 安装方法

### 本地开发

```bash
npm install                                   # 安装依赖（postinstall 自动 prisma generate）
cp .env.example .env                          # 复制环境变量并修改
npm run db:up                                 # 启动内嵌 PostgreSQL（端口见 DATABASE_URL）
npm run db:push                               # 同步表结构
node scripts/create-admin.mjs admin 用户名 密码   # 创建管理员
npm run dev                                   # http://localhost:3000
```

> 本地搜索：下载 meilisearch 二进制后执行
> `bin\meilisearch.exe --db-path meili_data --http-addr 127.0.0.1:7700 --master-key dev-xxx`
>
> Meili 秒级同步守护进程（生产用）：`npm run meili:sync`（prompts / skills / software 三索引增量同步）

### 服务器部署（宝塔 + Docker）

详细步骤见 [docs/server-部署指南.md](docs/server-部署指南.md)，概要：

```bash
# 1. 启动数据库与搜索（PG 反代 127.0.0.1:35432 / Meili 7700）
docker compose up -d

# 2. 建库并恢复数据
docker exec -it postgresql_18_kpJt psql -U woshizhou -d postgres -c "CREATE DATABASE prompthub;"
pg_restore --host 127.0.0.1 --port 35432 --username woshizhou --dbname prompthub --no-owner database/prompthub-dump.dump

# 3. 配置 .env（数据库/Meili/JWT_SECRET/站点 URL）
# 4. 安装依赖并构建，PM2 托管
npm install && npm run build
pm2 start ecosystem.config.cjs
# 5. 宝塔 Nginx 反代 3000 端口 + SSL；Meili 反代 meili.域名.com
```

### 媒体文件传输（重要）
`public/uploads/` 约 4GB / 7 万文件，**不在 git 内**，部署时需单独传输到服务器同路径：
- 宝塔文件管理上传压缩包解压；或 `scp -r public/uploads root@服务器:/www/wwwroot/CompletePrompt/public/`
- 部署后 `chown -R www:www public/uploads`（PM2 以 www 用户运行）

## 更新日志

### v0.93.2

> 修复存储桶「测试连接」报错（「Unexpected end of JSON input」）。

- **存储桶测试连接接口容错**：`/api/admin/storage/buckets/[id]/test` 与 `/api/admin/storage/buckets/test` 全链路 try/catch，异常一律返回 JSON 错误（此前未捕获异常返回空 500，前端报「Unexpected end of JSON input」）；桶 SecretKey 解密失败时给出明确提示「请重新填写并保存该桶的 SecretKey 后再测试」
- **前端安全解析**：存储桶设置（测试连接/保存/创建/删除）响应改为容错解析 JSON，空响应/非 JSON 响应给出明确提示
- 版本号升级 `v0.93.2`（`src/lib/version.ts`）/ `0.93.2`（package.json）

### v0.93.1

> 修复技能整包 .zip 上传报错（「Unexpected end of JSON input」）。

- **中间件请求体 10MB 截断修复**：Next.js 中间件缓冲请求体默认上限 10MB，会截断大文件上传（技能整包 zip / 软件包），配置 `experimental.middlewareClientMaxBodySize: 250MB` 放开
- **存储桶密钥解密失败可读化**：历史密文（桶 SecretKey）用旧密钥加密、当前密钥解不开时，`decryptSecret` 抛出可读错误；技能整包上传接口全链路 try/catch，异常一律返回 JSON 错误（此前未捕获异常返回空 500，前端报「Unexpected end of JSON input」）；提示到「存储桶设置」重新保存 SecretKey 恢复
- **前端安全解析**：技能表单上传/保存响应先取文本再容错解析 JSON，空响应/非 JSON 响应给出明确提示
- 版本号升级 `v0.93.1`（`src/lib/version.ts`）/ `0.93.1`（package.json）

### v0.93

> 后台编辑器升级与技能整包上传，附前台视觉微调。

- **后台富文本编辑器升级（P0）**：RichEditor 基于 Tiptap v3 全面重写——H1-H6 全级标题、表格（增删行列/合并拆分）、代码块（16 种语言高亮）、行内代码、高亮标记、引用、列表、分割线、链接、图片（上传+URL）、视频、HTML 源码模式、撤销重做，支持 Markdown 粘贴自动转换为富文本；全站 7 处富文本（工单、消息中心、发布提示词等）统一生效；sanitize 白名单同步扩充（h4-h6/hr/mark/表格/colspan/rowspan），前台 `.rich-content` 补表格/代码块/高亮排版样式
- **分段提示词编辑器（P0）**：新增 SegmentedPromptEditor——`[N] 标题` 分段卡片式编辑，支持增删/上下移动/自动重编号/粘贴长文一键拆分为分段；后台提示词表单支持「富文本 / 分段」双内容模式，旧纯文本数据自动进入分段模式，可直接编辑出「本页结构 53 段」式大篇幅提示词
- **技能 .zip 整包上传（P0）**：后台技能管理支持上传 .zip 整包（必须含 SKILL.md，自动剥一层包装目录，拒绝越级路径），原始 zip 直存默认桶、下载时原样回传；支持多选 .md 文件与文件树预览；前台技能详情页展示文件树并隐藏内部哨兵文件
- **前台视觉微调**：提示词分类页大标题/副标题波浪线动画加粗加密（全蓝配色、隐约白色分割线），「已存 N 条提示词」改圆角胶囊（无动画）；技能详情页「相关技能」升级为完整卡片（随机 8 条，含说明/关联标签/复制次数/浏览数/查看按钮）
- 版本号升级 `v0.93`（`src/lib/version.ts`）/ `0.93.0`（package.json）

### v0.92

> v0.92 迭代（11 项需求）分批上线，本批交付「API 多线路 Base URL 与网关体验」补充需求与前台体验微调。

- **API 多线路 Base URL**：后台删除「API 网关域名（多线路，一行一个）」输入框，改为 Base URL 多线路编辑器——每行 名称 + URL（如「中国大陆线网关 / xinapi.com」，URL 支持一级/二级域名，保存后锁定不可改、逐行删除，「＋ 新增 Base URL」加行）；首条线路为文档主 Base URL，各线路域名为 `/v1` 网关白名单（`api_gateway_routes` 配置）
- **API 域名根路径 JSON 指引**：API 网关域名下非 `/v1` 路径不再渲染站点首页，统一返回 JSON 指引 `{"message": "The API documentation for this site can be found at the following URL: \`https://www.icebai.com/api-docs\`"}`（middleware + `/api/gateway-meta`，域名取配置 `NEXT_PUBLIC_SITE_URL`）
- **/v1 报错全英文化**：API 鉴权语义统一为 Key 语境英文提示（如 "Missing API key. Provide your key in the Authorization header: Authorization: Bearer sk-YOUR_KEY"），apikey/quota/billing/chat/images 全链路
- **弹层防误关（P0）**：全站 13 处弹层（后台管理/模型库/积分包/单页编辑/工单、会员中心/API Key、PromptToc 等）不再点击遮罩关闭，只能点关闭/取消按钮或提交成功自动关闭；提示词图片放大预览保留点外关闭
- **前台导航微调**：「注册登录」按钮与「语言选择」按钮位置对调（登录在左、语言在右）；积分充值页去掉「本地开发模式，模拟支付（未接入真实网关）」提示文案
- **工单后台重构（P0）**：发工单标题改「问题类型」下拉必选（请选择您想提交的问题/会员问题/资金积分问题/API使用问题/发票问题/其他问题）；工单列表改列（问题类型/会员账号/昵称/状态/消息更新时间/创建时间/回复人/查看回复），状态四档「新工单需处理/新的消息需处理/已回复过此工单/已关闭」+ 新会员消息红标数字；新增客服式详情页（左栏会员信息 2 列竖排：账号/账户状态/发布权限/评论权限/当前积分/APIKey 数量/注册时间/注册IP/登录时间/登录IP，右栏消息流 + 发票快捷模板）；回复记录管理账号（`replyBy`/`replyByNick`），前台只显管理员昵称；管理侧全功能富文本、会员侧富文本只留图片上传自动插入（写入前 sanitize）；「回复后关闭此工单」勾选默认不勾
- **会员工单前台改版**：客服聊天软件式界面（对话气泡 + 客服头像 + 时间线 + 底部输入栏 + 自动滚到底部）；会员侧新增「关闭工单」按钮（确认后关闭，关闭后转入新建工单引导）
- **积分包拆分（P1）**：`CreditPack` 新增 `bonusCredits` 赠送积分字段（购买积分与赠送积分分开填写，发放按 `credits + bonusCredits`）；后台积分包表格拆「购买积分/赠送积分」两列；前台充值页展示「50元 5000积分 + 赠100积分」，无赠送不显示 + 赠字样；会员中心「余额」Tab 改「我的积分」；线上数据迁移 p50=5000+100、p200=20000+2500
- **模型计费透明化（P1）**：对外展示统一「百万 tokens 成本价/会员价（积分）」口径（1 元 = 100 积分，`perMillionCostCredits`/`perMillionMemberCredits`）；模型列表「成本预览」列改「百万tokens 成本/会员价」，模型详情定价改三行展示（成本价/会员价/单价辅助信息），定价试算与手动换算全部由毫积分改积分；用量报表、运营告警指标、毛利告警文案统一积分口径
- **运营告警重构（P1）**：阈值配置加「自动巡检总开关」；新增「支付异常」（近 24h 失败订单数）与「注册异常」（同 IP 24h 注册数）两类告警项；注册赠送开关从运营告警页迁入「会员管理-注册设置」（`RegisterGiftForm`）；新增 `/api/cron/alerts-check` cron 自动巡检入口（CRON_SECRET 鉴权，服务器 crontab 每小时第 25 分钟执行，线上已接入并验证）
- **会员中心重设计（P2）**：Tab 栏改「大栏目小栏目」左侧折叠菜单（账户设置/积分财务/用量·API/我的内容/模型服务）；新增「资料修改」（头像上传前端裁剪——拖动定位+缩放滑杆、canvas 裁剪后上传；昵称/手机/邮箱/微信/QQ/Telegram/生日/性别/国籍/简介，手机与邮箱唯一性校验）、修改密码（旧密码校验 + 新密码 6-64 位）、收藏夹（提示词/技能/软件三类切换+取消收藏；提示词走 `Favorite` 旧表兼容，技能/软件走新 `UserFavorite` 通用收藏表）
- **会员中心模型列表（P2）**：新增「模型列表」Tab——全部模型计数 + 厂商计数总览卡；按厂商分组折叠菜单（组内模型计数徽章），每行展示模型名称（展示名/接口名）、类型、支持功能标签（对话补全/图像生成/视频生成等）与备注；仅显示后台已上线（online）模型
- 版本号升级 `v0.92`（`src/lib/version.ts`）/ `0.92.0`（package.json）

### v0.91

> v0.90 会员订阅额度与聚合网关系统首次部署上线，连同 SEO 整站优化与列表排序修复一起发布。

- **v0.90 全量上线**：会员积分与聚合网关（`/v1/chat/completions`、`/v1/images/generations`）、模型库管理、用户中心、站务单页、运营完善等全部部署至生产（数据库同步 v0.90 新增表）
- **SEO 整站优化**：sitemap 改为索引 + 分片（`/sitemap.xml` 引导全部已发布 URL 分片，取消 2 万/5 千截断）、robots.txt 强化、HSTS 安全响应头、登录/注册/会员等页 `noindex`、全站 meta description 清洗截断（`src/lib/seo.ts`）、结构化数据 JSON-LD（BreadcrumbList 等）、各栏目/详情页 metadata 补全
- **API 网关域名白名单**：`/v1` 网关接口仅允许后台配置的 API 域名（可多个=多线路）调用，其他任何域名一律 404 静默隐藏；后台「模型库 → API 文档」页可配置，留空默认取 `.env` 配置 `API_GATEWAY_BASE_URL` / `API_GATEWAY_HOSTS`，改完立即生效
- **列表排序修复**：技能/软件列表按 `publishedAt` 倒序时 NULL 值不再钉在最前（`nulls: "last"` + `createdAt`/`id` 兜底），数据回填 `Skill.publishedAt` 空值
- 版本号升级 `v0.91`（`src/lib/version.ts`）/ `0.91.0`（package.json）

### v0.90

> 依据《CompletePrompt 会员订阅额度与聚合网关方案 v2.4》P0~P6 分期落地，本地开发完成后随 v0.91 首次部署上线（commit `ebcc548`）。

- **P0 站务改版**：Footer 三列（产品目录/支持/法律）+ 中英 i18n；帮助/关于/联系/服务条款/隐私政策 5 单页（后台 SitePage 可视化编辑、进 sitemap）+ API 文档页 `/api-docs`
- **P1 原生网关底座**：`/v1/chat/completions` OpenAI 兼容 SSE 流式透传、`/v1/images/generations`；key_model_binding 优先级/权重路由、失败降级换 Key（≤3 次）；usage_record 计量入库；站内会员 / `sk-` API Key 统一鉴权
- **P2 会员积分闭环**：整数积分计费（`src/lib/credits.ts`，BigInt、ceil 取整、流水幂等）——预扣/结算退差/补扣封顶 est×3/失败整数退回；<200 积分禁生图/生视频；CreditPack/CreditGrant/CreditLedger/PayOrder/MemberPlan/UserSubscription 表；支付 5 通道 adapter（微信/支付宝/自定义/Stripe/加密货币 stub）
- **P3 模型库管理**：AiVendor → VendorApiKey → AiModel → ModelEndpoint 四级 + KeyModelBinding + ModelPricing 调价历史；后台模型库页与用量成本报表（成本毫积分换算：计量值×单价×fxRateE8/1e8×100积分/元×1000毫/积分÷meterBase，标价=ceil(成本×multiplierBps)）
- **P4 用户中心**：会员中心 6 Tab（余额/充值/用量/资产/消息工单/API Key）+ 充值页 + 消息中心；导航栏未读消息数
- **P5 站外双通道**：API Key 管理（`sk-` 生成/sha256 存储/明文一次性展示）、图/视频 adapter（同步/异步任务两模式）、生成产物转存默认桶（`generated/{uid}/` 路径、30 天生命周期、签名 URL 私有读）
- **P6 运营完善**：运营告警（OperationalAlert）、消息群发、发票/工单处理、PRO 权益开关；站点单页后台编辑
- **后台 CRUD/批量补齐**：用户管理加「调整积分」（adminAdjust 幂等调账）+ 批量启禁用/发布/禁言/删除；网站设置加「支付渠道配置」（五通道增删改查、敏感字段脱敏留空保持原值）；积分包补新建/删除/批量上下架；模型库/消息工单/运营告警统一补批量启用禁用/关闭/确认/删除（含全选与确认交互）
- 版本号升级 `v0.90`（`src/lib/version.ts`）/ `0.90.0`（package.json）；`npm run build` 全量通过

### v0.85

- **首页工具区 UI 打磨**：输入框改白底内嵌「优化」按钮（聚焦蓝光、尺寸缩小）；输出框改用技能详情页 SKILL.md 样式（顶栏左「神器优化后提示词」右复制/下载，高度缩小）；统计胶囊/大标题/英文/介绍/图标行全部单行不截字，图标行精简 8 个防裁切；手机端统计胶囊与大标题单行显示
- **优化器使用记录**：新增 `OptimizerLog` 表（IP/使用时间/提交提示词/优化结果/错误内容，不落用户账号），每次前台使用即记一条；后台「网站设置」下新增「优化器使用记录」栏目——20 条/页、按使用时间倒序、行内截断展示、「查看详细」弹层用 SKILL.md 样式多行框完整显示两个提示词与错误；优化按钮请求期间禁用防猛点
- **提示词详情页改版**：参考 ai-skills.ai 大气设计，新增左侧「本页结构」分段目录（两位数编号 01/NN + 当前阅读高亮 + 平滑跳转），分段头部 `01 / NN` 编号清晰；中小屏目录折为右下角小图标，点开弹层选段
- **后台优化技能文档可编辑**：网站设置内 System Prompt 可视化编辑（留空用内置 PromptOptimizer v2.0），并修复连接测试误报（max_tokens 8→512 + reasoning_content 兜底 + 透出真实报错）
- **分类计数修复**：v0.75 导入数据 category/type 中文值归一化为短码/枚举，分类页统计恢复实时准确

### v0.80

- **首页功能大改**：Banner 图区域整体替换为「神器·全能提示词优化器」工具区——库存统计胶囊 + 大标题 + Master Prompt Optimizer + 输入框 + 优化按钮 + 模型/工具图标行 + 只读输出框 + 复制/下载（.txt 首行带来源注释），向中心聚光渐变视觉
- **提示词优化 API**：`/api/optimize` 调用 DeepSeek（deepseek-flash），system prompt 内置 PromptOptimizer 技能文档（8 领域专家知识库），IP 限流 10 次/5 分钟；后台网站设置可配 API Key（留空回退 `DEEPSEEK_API_KEY` 环境变量）并一键连接测试
- **Banner 图功能下线**：后台网站设置移除首页 Banner 图配置
- **全站配色重调**：深靛藏青底（#091030/#0b1338）+ 天蓝品牌色 + 青色聚光点缀，一处 @theme 色板驱动全站

### v0.75

- **视觉改版**：全站配色升级为深藏青蓝 + 天蓝强调（`globals.css` 一处 @theme 色板驱动全站），搜索框改大胶囊样式
- **搜索页改版**：左侧「全部/提示词/AI技能/AI软件」类型筛选（吸顶+计数徽章+可展开子分类）+ 右侧结果列表；顶部导航在搜索页隐藏搜索框，去掉重复入口；关键字高亮、三层相关度排序；移动端筛选置顶两列布局
- **PromptHub 全量数据入库**：提示词 20000+ 条（剔除重复/无效/截断条目）、技能 625 条（标题中英对照），图片 27000+ 张全部本地化并与正文分段对应；正文从 RSC `search_text` 补全，绕开对方 API 100 字截断
- **技能 slug 去唯一约束**：URL 形式改为 `slug-id` 精确定位（旧纯 slug 链接保持兼容）
- 新增 [docs/ai/09-database-schema.md](docs/ai/09-database-schema.md) 数据库结构文档；清理历史一次性脚本与废文件

### v0.7

- **新增采集源**：PromptHub 技能库、PromptHub 提示词库（一键采集扩展到 4 个数据源）
  - 技能正文改为从 GitHub `raw` 拉取 SKILL.md 全文，绕开对方站点的纯客户端渲染限制
  - 采集条目统一 `sourceUrl = null`，不落原网址；分类走硬编码映射表自动归位
  - `CrawlItem` 新增 `skillId` 外键（唯一索引），技能入库后可反查来源条目
- **新增 Sitemaps 提交**：后台「网站设置」内置 sitemap 自检 + 搜索引擎推送，持久化上次提交记录
- 版本号统一收敛到 `src/lib/version.ts`（`APP_VERSION`），前后台共用一处升级
- 线上数据：sitemap 已收录 11000+ 条 URL；PromptHub 技能库首批 6 条技能正文入库

### v0.6

- 四大栏目改版（首页 / 提示词 / AI 技能 / AI 软件），`/hot` 下线热门并入首页精选
- 新增 AI 技能线（SKILL.md 编辑器 / 附加文件打包下载）与 AI 软件线（图标卡片 / 会员门控下载）
- 对象存储多桶管理、评论通用化（`targetType + targetId`）、Meilisearch 三索引

## 版权说明

提示词数据采集自公开社区，版权归原作者所有；如有需要联系站长（页脚 Telegram）。
