# ICEB AI LIBRARY · 冰山AI资料库

[English](./README.md) | **简体中文**

自建 AI 提示词 / AI 技能 / AI 软件资料库，同时包含会员与积分体系、OpenAI 兼容聚合网关和站内实验场。

- 展示网址：<https://www.icebai.com>
- 联系方式：support@icebai.com · X [@icebaicom](https://x.com/icebaicom)

## 目录

- [项目是什么](#项目是什么)
- [主要功能](#主要功能)
- [技术栈与依赖服务](#技术栈与依赖服务)
- [项目截图](#项目截图)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [本地启动](#本地启动)
- [环境变量](#环境变量)
- [临时文件](#临时文件)
- [构建与发版](#构建与发版)
- [版本号规则](#版本号规则)
- [文档](#文档)

## 项目是什么

ICEB AI LIBRARY 是一个 Next.js 应用，在同一套代码里提供三块能力：

1. **内容资料库**：按创作类型（文本 / 文生图 / 文生视频 / 文生音频）与分段结构组织的提示词、SKILL.md 技能，以及软件栏目。
2. **账号与计费**：会员、积分、充值订单、会员订阅、积分流水与用量记录。
3. **OpenAI 兼容网关**：`/v1/*` 提供对话（SSE 流式）、图像、向量、音频、视频接口，背后是多厂商多 Key 的模型库与按次计费。

同一次部署还承载**实验场**（站内直接跑模型）和**独立后台**（管理员单独建表，RBAC 权限位 + 操作日志）。

## 主要功能

- **内容资料库**：提示词 / 技能 / 软件三栏目，分类短码路由、标签体系、分段提示词与实拍图、视频截图一一对应。
- **搜索**：Meilisearch 双索引（`prompts`、`skills`）一次查询合并，相关度排序与「最新优先」可切换；独立同步守护进程维护索引。
- **积分计费**：整数积分预扣 / 结算 / 退补，同一 `requestId` 幂等，失败自动对账补偿。
- **模型库**：厂商 → Key → 模型 → 端点四级管理，成本与毛利可核算，Key 密文存储、轮换与失败换 Key 重试。
- **聚合网关**：OpenAI 兼容 `/v1/chat/completions`（SSE）、`/v1/images/generations`、`/v1/embeddings`、`/v1/audio/*`、`/v1/videos`，并提供非 OpenAI 厂商的协议适配。
- **实验场**：站内对话与图像 / 视频 / 音频生成，支持素材上传、按模型能力显隐参数、收藏、会话与媒体任务持久化。
- **一键采集**：LibLib TV、即梦 AI、PromptHub 技能库 / 提示词库四类来源，自动去重，图片与视频本地化（超限时降级为截帧）。
- **后台管理**：仪表盘、内容与评论、会员与订单、模型库与定价、支付渠道、采集、运营告警、邮件模板、站点设置。
- **安全基线**：会员 / 管理员双 JWT 密钥与双 Cookie、上传魔数校验、富文本白名单净化、站内重定向加固、必需密钥缺失时生产环境拒绝启动。
- **部署可控**：本地构建、产物原子替换上线，构建失败不影响线上；PM2 托管 web 与队列 worker，Nginx 反代。

## 技术栈与依赖服务

| 层 | 选型 |
|---|---|
| 前端 | Next.js 15（App Router / RSC）、React 19、Tailwind CSS 4、Tiptap 3 |
| 服务端 | Next.js Route Handlers（`/api/*` 站内接口、`/v1/*` 聚合网关）、Middleware |
| 数据 | PostgreSQL 18 + Prisma 6 |
| 搜索 | Meilisearch 1.12（`prompts` / `skills` 双索引 + 同步守护进程） |
| 队列 | Redis + BullMQ（视频 / 图片 / 产物任务，独立 worker 进程） |
| 存储 | S3 兼容对象存储（MinIO 等），预签名直链，SecretKey 以 AES-256-GCM 加密存储 |
| 媒体 | sharp（图片处理）、ffmpeg / ffprobe（视频探测与截帧） |
| 鉴权 | jose JWT，会员 / 管理员双密钥双 Cookie，RBAC 权限位 |
| 邮件 | nodemailer + 后台可编辑模板 |
| 测试 | Vitest（单元 / e2e 契约）、k6（压测基线） |
| 运行 | PM2（`CompletePrompt` web + `CompletePrompt-Worker`）、Nginx 反向代理 |

## 项目截图

| 前台桌面 | 前台手机 | 后台 |
|---|---|---|
| ![桌面](./PC.png) | ![手机](./mobile.png) | ![后台](./caiji.png) |

## 目录结构

```text
CompletePrompt/
├─ src/
│  ├─ app/
│  │  ├─ (site)/            前台页面：首页、提示词、技能、软件、分类、
│  │  │                     搜索、实验场、会员中心、发布等
│  │  ├─ (admin)/guanli-7k2m9x/  后台页面
│  │  ├─ (admin-auth)/      后台登录 / 找回密码
│  │  ├─ api/               站内 JSON 接口（auth、comments、积分、采集、
│  │  │                     实验场、cron、上传、设置等）
│  │  ├─ v1/                OpenAI 兼容网关
│  │  ├─ sitemap.xml/       站点地图索引与分片（ISR）
│  │  └─ robots.ts
│  ├─ components/           UI：admin、editor、effects、media、member、playground
│  └─ lib/                  共享模块
│     ├─ admin/  gateway/  ops/  payments/  playground/  queue/
│     └─ meili.ts、db.ts、auth.ts、rate-limit.ts、tmp-dir.server.ts…
├─ prisma/
│  ├─ schema.prisma         唯一 schema（结构以此为准）
│  └─ sql/                  特定版本的一次性 SQL 备注
├─ scripts/                 worker 构建、Meili 重建 / 同步、种子、管理员、校验脚本
├─ worker/                  main.ts → main.cjs（esbuild 打包，由 PM2 运行）
├─ tests/                   unit / e2e / k6
├─ docs/                    部署、Meilisearch、接口契约、ADR、AI 协作说明
├─ public/                  静态资源；uploads/ 存运行期媒体（不入库）
├─ docker-compose.yml       服务器用 PostgreSQL + Meilisearch
├─ ecosystem.config.cjs     PM2：web + worker
├─ next.config.ts           响应头、重定向、distDir 覆盖
└─ .env.example             环境变量模板
```

部署脚本**不在仓库内**（见[构建与发版](#构建与发版)）。

## 环境要求

- Node.js **18.18+**（推荐 20 LTS）与 npm
- PostgreSQL **18**（本地 Windows 服务，或服务器上的 compose）
- Meilisearch **1.12**
- 可选：Redis **7+**（配置 `REDIS_URL` 后启用 BullMQ 队列与 worker）、ffmpeg / ffprobe（视频截帧、采集本地化、实验场视频）

`docker-compose.yml` 用于启动 PostgreSQL 与 Meilisearch，端口只绑定本机，面向服务器部署，不是本地开发必需。

## 本地启动

```bash
npm install                                   # postinstall 自动执行 prisma generate
cp .env.example .env                          # 按注释填写，.env 不入库
npm run db:push                               # 同步表结构到已启动的数据库
node scripts/create-admin.mjs <用户名> <密码>
npm run dev                                   # http://localhost:3000
```

- 后台入口：`http://localhost:3000/guanli-7k2m9x`
- 示例 `.env` 默认连接本机 Windows PostgreSQL 服务（`localhost:5433`，库 `icebaidata`）。
- 搜索需本地启动 Meilisearch，并与 `MEILI_HOST` 对应：

  ```bash
  meilisearch --db-path meili_data --http-addr 127.0.0.1:7700 --master-key <本地主密钥>
  ```

  Windows 下二进制可能放在仓库外（如 `bin\meilisearch.exe`）；`meili_data/` 不要入库。

`next dev` 会写入 `.next`。若不想让 dev 产物污染待发版的 `.next`，启动前设置 `NEXT_DIST_DIR=.next-preview`（见 `next.config.ts`）。

## 环境变量

所有运行配置集中在仓库根目录 `.env`（模板 `.env.example`），代码中不写死域名、端口与密钥。**真实密钥严禁入库**，下表仅示意。

### 必需

| 键 | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串，如 `postgresql://user:password@127.0.0.1:5433/icebaidata?schema=public`；生产建议带 `connection_limit` / `pool_timeout`。 |
| `JWT_SECRET` | 会员令牌签名密钥（`openssl rand -hex 32`）。生产缺失会拒绝启动。 |
| `JWT_ADMIN_SECRET` | 管理员令牌独立密钥；缺省回退 `JWT_SECRET` 并告警，生产建议单独配置。 |
| `MEILI_HOST` | Meilisearch 地址：本地 `http://127.0.0.1:7700`，生产可走域名。 |
| `MEILI_MASTER_KEY` | Meilisearch 主密钥。 |
| `NEXT_PUBLIC_SITE_URL` | 站点对外域名，canonical、sitemap、分享链接、水印统一取值；**构建前必须是目标域名**。 |
| `STORAGE_KEY_SECRET` | 存储 SecretKey 的 AES-256-GCM 加密密钥；更换后需在后台重新填写各桶密钥。 |

### 可选

| 键 | 用途 / 默认值 |
|---|---|
| `API_GATEWAY_BASE_URL` | `/v1` 网关对外域名；缺省取 `NEXT_PUBLIC_SITE_URL`。 |
| `API_GATEWAY_HOSTS` | `/v1` 额外白名单域名，逗号分隔；缺省取网关域名。 |
| `JWT_USER_TTL_DAYS` / `JWT_ADMIN_TTL_DAYS` | 令牌有效期（天）：30 / 7。 |
| `PORT` / `PM2_MAX_MEMORY` / `PM2_WORKER_MAX_MEMORY` | 应用端口（3000）与 PM2 内存上限（1G / 512M）。 |
| `APP_TMP_DIR` | 覆盖项目内临时目录（见[临时文件](#临时文件)）。 |
| `REDIS_URL` | Redis 连接串；留空则队列、限流与共享状态回退进程内。 |
| `SHARED_REDIS_CONNECT_TIMEOUT_MS` / `SHARED_REDIS_TIMEOUT_MS` | 共享状态短连接超时（1000 / 800 毫秒）。 |
| `CRON_SECRET` | crontab 调用 `/api/cron/*` 的鉴权密钥。 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 显式指定可执行文件；缺省走 `PATH`。 |
| `PLAYGROUND_MEDIA_STORAGE` | `local`（默认，落 `public/uploads`）或 `s3`。 |
| `PLAYGROUND_SESSION_RETENTION_DAYS` / `PLAYGROUND_SKILL_WHITELIST` | 会话留存天数（0=保留）/ 技能白名单（空=不限）。 |
| `VIDEO_TASK_POLL_MS` / `VIDEO_WORKER_CONCURRENCY` | 视频任务轮询间隔（3000 毫秒）/ worker 并发。 |
| `CRAWL_VIDEO_MAX_MB` / `CRAWL_VIDEO_MAX_SECONDS` / `CRAWL_VIDEO_TIMEOUT_MS` | 采集视频体积、时长上限与下载超时；超限降级为截帧。 |
| `BYTEDANCE_TTS_*` | 字节 TTS 适配器的超时与轮询间隔。 |
| `DEEPSEEK_API_KEY` | 提示词优化器兜底密钥；后台站点设置优先。 |
| `K6_*` | 仅本地压测夹具使用。 |

不走 `.env` 的部分：框架配置文件，以及注册开关、会员权益、积分包、支付渠道、SMTP、告警阈值、SEO 等业务参数——它们存在数据库表中，由后台页面维护。

## 临时文件

- 运行期临时文件（采集下载、截帧、转码中转、上传过程中的落盘）统一放在**仓库内 `tmp/`**，路径由 [`src/lib/tmp-dir.server.ts`](./src/lib/tmp-dir.server.ts) 解析，目录按需创建。
- 可用 `APP_TMP_DIR` 覆盖（建议写绝对路径）。运行用户必须对该目录有写权限，否则报错信息会带上解析后的路径与错误码。
- 不要依赖系统 `/tmp`：线上可能属于 root 且应用用户不可写。
- 代码不做定时清理，由运维工具负责；`tmp/` 已在 `.gitignore` 中。

## 构建与发版

```bash
npm run build      # next build + esbuild 打包 worker/main.ts → worker/main.cjs
npm start          # next start（线上通常由 PM2 启动）
```

生产环境**不在服务器构建**，而是本地构建后上传产物。

典型流程（辅助脚本放在仓库同级的 `bushu/` 等目录，不提交到仓库）：

1. **本地打包**：打包脚本会先检查是否存在 `next dev` 进程（有则拒绝执行），重新构建，校验 `.next/BUILD_ID` 与 worker 产物，拦截 dev 产物（`static/development`、hot-update 文件），再打包 `.next`（不含 `cache`）、`src`、`prisma`、`scripts`、`worker` 与配置文件。
2. **上传**：压缩包与部署 shell 脚本通过 SSH 传到服务器。
3. **服务端部署**：解包到独立构建目录 → 校验 `BUILD_ID` 与必需环境变量 → 预览 Prisma 结构差异（只允许 `ADD COLUMN`）→ 可选 `pg_dump` 备份 → `prisma db push` → 原子替换 `.next` 并同步 `src` / `prisma` / `scripts` / `worker` → `prisma generate` → `chown -R www:www` → 重启 web、拉起 worker → 媒体任务回填 → 自检首页 / 实验场 / 后台金丝雀。
4. **回滚**：服务器保留上一版产物为 `.next.old-<时间戳>`。

不要用同一个 `.next` 同时跑 `next dev` 和线上产物：dev 产物混入生产包会导致客户端 500。

## 版本号规则

- 版本号存在**两处，发版时必须同步**：
  - `package.json` → `"version"`（如 `1.0.116`）
  - [`src/lib/version.ts`](./src/lib/version.ts) → `APP_VERSION`（如 `"v1.0.116"`）
- 只在发版时升版本；本地预览阶段保持当前已发布版本不变。
- 采用 `1.0.x` 递增：修复与小改走 patch，成批功能走 minor。外部进度表与打包脚本注释在同一次发版中一并更新。
- 后台界面展示取 `src/lib/version.ts`，机器可读的版本以 `package.json` 为准。

## 文档

- [`docs/server-部署指南.md`](./docs/server-部署指南.md)：服务器、Nginx、PM2
- [`docs/meilisearch-部署指南.md`](./docs/meilisearch-部署指南.md)：Meilisearch 部署与索引
- [`docs/内部接口契约-v1.md`](./docs/内部接口契约-v1.md)：内部接口契约
- [`docs/数据归属与备份.md`](./docs/数据归属与备份.md)：数据归属与备份
- [`docs/adr/`](./docs/adr)：架构决策记录
- [`docs/ai/`](./docs/ai)：AI 协作实现说明（任务协议、契约、schema、易错点）
