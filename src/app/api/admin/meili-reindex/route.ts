import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { requireAdmin } from "@/lib/auth";
import { requirePerm, PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── 搜索数据全更新 ───
// 后台「搜索管理」页按钮触发，执行 node scripts/reindex-meili.mjs 全量重建
// MeiliSearch 三索引（prompts / skills / software）
// POST 启动任务（进行中重复点击直接拒绝）；GET 查询状态/日志尾部（前端轮询）

type Job = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  log: string;
};

const IDLE: Job = { running: false, startedAt: null, finishedAt: null, ok: null, log: "" };

// 模块级单例任务状态（fork 单实例 PM2 部署，天然互斥；10 分钟兜底超时）
let job: Job = { ...IDLE };
let proc: ReturnType<typeof spawn> | null = null;

const MAX_LOG = 4000;

function pushLog(chunk: string) {
  job.log = (job.log + chunk).slice(-MAX_LOG);
}

export async function POST() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });
  if (job.running) {
    return NextResponse.json({ error: "已有重建任务进行中，请等待完成" }, { status: 409 });
  }

  job = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    log: "正在启动全量重建…\n",
  };

  const child = spawn(process.execPath, ["scripts/reindex-meili.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  proc = child;
  child.stdout.on("data", (d: Buffer) => pushLog(d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => pushLog(d.toString("utf8")));
  child.on("error", (e: Error) => {
    pushLog(`\n启动失败：${e.message}\n`);
    job = { ...job, running: false, finishedAt: new Date().toISOString(), ok: false };
    proc = null;
  });
  child.on("close", (code: number | null) => {
    pushLog(`\n进程退出（code ${code}）\n`);
    job = { ...job, running: false, finishedAt: new Date().toISOString(), ok: code === 0 };
    proc = null;
  });

  // 10 分钟兜底超时，防止任务卡死占用单例槽位
  setTimeout(() => {
    if (job.running && proc) {
      pushLog("\n任务超时（10 分钟），已强制终止\n");
      try { proc.kill(); } catch { /* 忽略 */ }
    }
  }, 10 * 60 * 1000);

  return NextResponse.json({ started: true });
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });
  return NextResponse.json(job);
}
