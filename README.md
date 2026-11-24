# ICEB AI LIBRARY

**English** | [简体中文](./README.zh-CN.md)

A self-hosted AI prompt / skill / software library, with a membership & credits system, an OpenAI-compatible API gateway, and an in-site playground.

- Website: <https://www.icebai.com>
- Contact: support@icebai.com · X [@icebaicom](https://x.com/icebaicom)

## Contents

- [What it is](#what-it-is)
- [Main features](#main-features)
- [Tech stack & services](#tech-stack--services)
- [Screenshots](#screenshots)
- [Directory structure](#directory-structure)
- [Requirements](#requirements)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Temp files](#temp-files)
- [Build & release](#build--release)
- [Versioning](#versioning)
- [Docs](#docs)

## What it is

ICEB AI LIBRARY is a Next.js application that packages three products in one codebase:

1. **Content library** — prompts organized by creation type (text / image / video / audio) and segment structure, SKILL.md-style skills, and a software section.
2. **Account & billing** — members, credits, recharge and subscription orders, credit ledger, usage records.
3. **OpenAI-compatible gateway** — `/v1/*` endpoints for chat, images, embeddings, audio and video, backed by a multi-vendor / multi-key model registry with per-request billing.

The same deployment also hosts the **playground** (run models in the browser) and a **separate admin console** (admins live in their own table, with RBAC and audit logs).

## Main features

- **Content library**: prompt / skill / software sections, short-code category routes, tags, segmented prompt bodies with matching images and video stills.
- **Search**: Meilisearch over two indices (`prompts`, `skills`) in one query, merged relevance ranking with an optional "newest first" sort. A separate sync daemon keeps indices up to date.
- **Credits billing**: integer credits are pre-charged, settled and refunded; a shared `requestId` keeps operations idempotent, and failures are reconciled and compensated.
- **Model registry**: vendor → key → model → endpoint, with cost/margin accounting, key encryption at rest, key rotation and failover on error.
- **API gateway**: OpenAI-compatible `/v1/chat/completions` (SSE), `/v1/images/generations`, `/v1/embeddings`, `/v1/audio/*`, `/v1/videos`, plus protocol adapters for non-OpenAI vendors.
- **Playground**: in-site chat and image / video / audio generation, material uploads, per-model parameter panels, favorites, persisted sessions and media tasks.
- **Collection**: import from LibLib TV, Jimeng AI, and PromptHub (skills / prompts) with de-duplication and local media mirroring (image download, video localization or frame fallback).
- **Admin console**: dashboard, content & comments, members & orders, model library & pricing, payment channels, collection, alerts, email templates, site settings.
- **Security baseline**: separate JWT secrets for members and admins, upload magic-byte validation, sanitized rich text, hardened in-site redirects, and fail-fast startup when required secrets are missing.
- **Deployable**: build locally, ship an atomic replacement of `.next`; a failed build never touches the live site. PM2 supervises the web process and the queue worker behind Nginx.

## Tech stack & services

| Area | Choice |
|---|---|
| Frontend | Next.js 15 (App Router / RSC), React 19, Tailwind CSS 4, Tiptap 3 |
| Server | Next.js Route Handlers (`/api/*` internal, `/v1/*` gateway), Middleware |
| Database | PostgreSQL 18 + Prisma 6 |
| Search | Meilisearch 1.12 (`prompts` / `skills` indices, sync daemon) |
| Queue | Redis + BullMQ (video / image / asset jobs, separate worker process) |
| Storage | S3-compatible (MinIO etc.), presigned URLs, AES-256-GCM encrypted secrets |
| Media | sharp (image processing), ffmpeg / ffprobe (video probe & frames) |
| Auth | jose JWT, dual secrets & cookies, RBAC bitmask |
| Mail | nodemailer with admin-editable templates |
| Tests | Vitest (unit / e2e contracts), k6 (load baselines) |
| Runtime | PM2 (`CompletePrompt` web + `CompletePrompt-Worker`), Nginx reverse proxy |

## Screenshots

| Site (desktop) | Site (mobile) | Admin |
|---|---|---|
| ![Desktop](./PC.png) | ![Mobile](./mobile.png) | ![Admin](./caiji.png) |

## Directory structure

```text
CompletePrompt/
├─ src/
│  ├─ app/
│  │  ├─ (site)/            public pages: home, prompts, skills, software,
│  │  │                     categories, search, playground, member, publish…
│  │  ├─ (admin)/guanli-7k2m9x/  admin console pages
│  │  ├─ (admin-auth)/      admin login / password reset
│  │  ├─ api/               internal JSON APIs (auth, comments, credits,
│  │  │                     collect, playground, cron, upload, settings…)
│  │  ├─ v1/                OpenAI-compatible gateway
│  │  ├─ sitemap.xml/       sitemap index & shards (ISR)
│  │  └─ robots.ts
│  ├─ components/           UI: admin, editor, effects, media, member, playground
│  └─ lib/                  shared server/client modules
│     ├─ admin/  gateway/  ops/  payments/  playground/  queue/
│     └─ meili.ts, db.ts, auth.ts, rate-limit.ts, tmp-dir.server.ts…
├─ prisma/
│  ├─ schema.prisma         single schema (source of truth)
│  └─ sql/                  one-off SQL notes for specific releases
├─ scripts/                 build-worker, meili reindex/sync, seeds, admin, checks
├─ worker/                  main.ts → main.cjs (esbuild bundle, run by PM2)
├─ tests/                   unit / e2e / k6
├─ docs/                    deployment, Meilisearch, contracts, ADRs, AI notes
├─ public/                  static assets; uploads/ holds runtime media (git-ignored)
├─ docker-compose.yml       PostgreSQL + Meilisearch for servers
├─ ecosystem.config.cjs     PM2: web + worker
├─ next.config.ts           headers, redirects, distDir override
└─ .env.example             environment template
```

Deployment scripts are intentionally **not** part of this repository (see [Build & release](#build--release)).

## Requirements

- Node.js **18.18+** (20 LTS recommended) and npm
- PostgreSQL **18** (local Windows service or the compose file on a server)
- Meilisearch **1.12**
- Optional: Redis **7+** (`REDIS_URL`, enables BullMQ queues and the worker), ffmpeg / ffprobe (video frames, collection localization, playground video)

`docker-compose.yml` starts PostgreSQL and Meilisearch with local-only port binding and is intended for servers, not for local app development.

## Local development

```bash
npm install                                   # postinstall runs prisma generate
cp .env.example .env                          # then edit values (never commit .env)
npm run db:push                               # sync schema to the running database
node scripts/create-admin.mjs <username> <password>
npm run dev                                   # http://localhost:3000
```

- Admin console: `http://localhost:3000/guanli-7k2m9x`
- The example `.env` points at a Windows PostgreSQL service on `localhost:5433`, database `icebaidata`.
- Meilisearch must be running and match `MEILI_HOST`, e.g.:

  ```bash
  meilisearch --db-path meili_data --http-addr 127.0.0.1:7700 --master-key <dev-master-key>
  ```

  On Windows the binary may live outside the repo (e.g. `bin\meilisearch.exe`); keep `meili_data/` out of version control.

`next dev` writes into `.next`. To keep a dev server from polluting a production build, set `NEXT_DIST_DIR=.next-preview` before running it (see `next.config.ts`).

## Environment variables

All runtime configuration lives in `.env` at the repo root (template: `.env.example`). Domain names, ports and secrets are never hard-coded. **Never commit real values**; the placeholders below are examples only.

### Required

| Key | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://user:password@127.0.0.1:5433/icebaidata?schema=public`. Add `connection_limit` / `pool_timeout` in production. |
| `JWT_SECRET` | Member token signing secret (`openssl rand -hex 32`). Missing in production → startup fails. |
| `JWT_ADMIN_SECRET` | Separate admin token secret. Falls back to `JWT_SECRET` with a warning; use a distinct value in production. |
| `MEILI_HOST` | Meilisearch base URL, e.g. `http://127.0.0.1:7700` locally, `https://meili.example.com` in production. |
| `MEILI_MASTER_KEY` | Meilisearch master key. |
| `NEXT_PUBLIC_SITE_URL` | Public site origin used for canonical URLs, sitemap, share links and watermarks. **Must be set to the target domain before building.** |
| `STORAGE_KEY_SECRET` | AES-256-GCM key that encrypts storage SecretKeys. Rotating it makes stored secret keys unreadable until re-entered in admin. |

### Optional

| Key | Purpose / default |
|---|---|
| `API_GATEWAY_BASE_URL` | Public gateway origin for `/v1`; defaults to `NEXT_PUBLIC_SITE_URL`. |
| `API_GATEWAY_HOSTS` | Comma-separated extra hosts accepted by `/v1`; defaults to the gateway host. |
| `JWT_USER_TTL_DAYS` / `JWT_ADMIN_TTL_DAYS` | Token lifetime in days (30 / 7). |
| `PORT` / `PM2_MAX_MEMORY` / `PM2_WORKER_MAX_MEMORY` | App port (3000) and PM2 memory limits (1G / 512M). |
| `APP_TMP_DIR` | Overrides the in-project temp directory (see [Temp files](#temp-files)). |
| `REDIS_URL` | Redis connection string. Empty → in-process fallbacks for queues, rate limits and shared state. |
| `SHARED_REDIS_CONNECT_TIMEOUT_MS` / `SHARED_REDIS_TIMEOUT_MS` | Timeouts (1000 / 800 ms) for short-lived shared-state connections. |
| `CRON_SECRET` | Header secret for `/api/cron/*` calls from crontab. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Explicit binaries; default to `PATH`. |
| `PLAYGROUND_MEDIA_STORAGE` | `local` (default, `public/uploads`) or `s3`. |
| `PLAYGROUND_SESSION_RETENTION_DAYS` / `PLAYGROUND_SKILL_WHITELIST` | Session retention (0 = keep) and skill allowlist (empty = all). |
| `VIDEO_TASK_POLL_MS` / `VIDEO_WORKER_CONCURRENCY` | Video task polling (3000 ms) and worker concurrency. |
| `CRAWL_VIDEO_MAX_MB` / `CRAWL_VIDEO_MAX_SECONDS` / `CRAWL_VIDEO_TIMEOUT_MS` | Collection video limits: oversize/overlong media degrades to a still frame. |
| `BYTEDANCE_TTS_*` | Timeouts and polling intervals for the ByteDance TTS adapter. |
| `DEEPSEEK_API_KEY` | Fallback key for the prompt optimizer; the value in site settings wins. |
| `K6_*` | Local load-test fixtures only. |

Not configured via `.env`: framework config files, and business settings (registration switch, membership benefits, credit packs, payment channels, SMTP, alert thresholds, SEO) which live in database tables and are edited in the admin console.

## Temp files

- Runtime temp files (collection downloads, frame extraction, transcoding staging, uploads in flight) go to **`<repo>/tmp`**, resolved by [`src/lib/tmp-dir.server.ts`](./src/lib/tmp-dir.server.ts). The directory is created on demand.
- Override the location with `APP_TMP_DIR` (absolute path recommended). The process user must be able to write there; the error message includes the resolved path and error code.
- Do not rely on system `/tmp`: on production it may be root-owned and unwritable for the app user.
- No automatic cleanup is performed by the code; ops tooling owns cleanup. `tmp/` is git-ignored.

## Build & release

```bash
npm run build      # next build + esbuild bundle of worker/main.ts → worker/main.cjs
npm start          # next start (usually run by PM2 instead)
```

Production releases are **built locally** and shipped as artifacts; the server never runs `next build`.

Typical flow (helper scripts live next to the repo, e.g. `bushu/`, and are not committed):

1. **Local pack** — the packaging script refuses to run while a `next dev` process is alive, rebuilds, checks `.next/BUILD_ID` and worker bundle, rejects dev artifacts (`static/development`, hot-update files), then tars `.next` (without `cache`), `src`, `prisma`, `scripts`, `worker` and the config files.
2. **Upload** — the archive and the deploy shell script are copied over SSH.
3. **Server deploy** — unpack into a separate build directory, verify `BUILD_ID` and required env keys, preview the Prisma diff (only `ADD COLUMN` is allowed), optionally `pg_dump` a backup, `prisma db push`, atomically move the old `.next` aside and the new one in place, sync `src` / `prisma` / `scripts` / `worker`, run `prisma generate`, `chown -R www:www`, `pm2 restart` the web process and reload the worker, run the media backfill, then self-check home / playground / admin canaries.
4. **Rollback** — the previous build is kept as `.next.old-<timestamp>` on the server.

Never point `next dev` at the same `.next` you ship: dev artifacts in a production build produce client-side 500s.

## Versioning

- The version is stored in **two files that must stay in sync**:
  - `package.json` → `"version"` (e.g. `1.0.116`)
  - [`src/lib/version.ts`](./src/lib/version.ts) → `APP_VERSION` (e.g. `"v1.0.116"`)
- Bump both only when releasing; local preview work keeps the current released version.
- Use `1.0.x` increments: patch for fixes and small changes, minor for feature batches. The external progress sheet and packaging script comments are updated in the same release step.
- `src/lib/version.ts` is the value displayed in the admin UI; `package.json` is the canonical machine-readable version.

## Docs

- [`docs/server-部署指南.md`](./docs/server-部署指南.md) — server, Nginx and PM2 setup
- [`docs/meilisearch-部署指南.md`](./docs/meilisearch-部署指南.md) — Meilisearch deployment and indices
- [`docs/内部接口契约-v1.md`](./docs/内部接口契约-v1.md) — internal API contracts
- [`docs/数据归属与备份.md`](./docs/数据归属与备份.md) — data ownership and backups
- [`docs/adr/`](./docs/adr) — architecture decision records
- [`docs/ai/`](./docs/ai) — implementation notes for AI agents (task protocol, contracts, schema, gotchas)
