import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { claimVideoTask, VIDEO_MAX_ATTEMPTS, VIDEO_WORKER_ID } from "@/lib/gateway/video-task";
import { claimMediaTask, MEDIA_MAX_ATTEMPTS, MEDIA_WORKER_ID } from "@/lib/playground/media-task-runner";

// ─── P6 #21 抢占 + 租约回归 ───
// 目标：进程崩溃/僵死后，lease 过期的 processing/running 能被接管；未过期的不许抢；
// attempts 达到上限后不再接管（由 reconciler 收口失败退款）。

let seq = 0;
let userId = 0;

async function ensureUser(): Promise<number> {
  if (userId) return userId;
  const u = await db.user.create({
    data: { username: `unit-lease-${Date.now()}-${++seq}`, passwordHash: "x", status: "active" },
  });
  userId = u.id;
  return userId;
}

function rid(tag: string): string {
  return `lease-${tag}-${Date.now()}-${++seq}`;
}

async function makeVideoTask(opts: {
  status: string;
  attempts?: number;
  lockedUntil?: Date | null;
  updatedAt?: Date;
}) {
  const uid = await ensureUser();
  return db.videoTask.create({
    data: {
      taskId: `vt-unit-${Date.now()}-${++seq}`,
      requestId: rid("vt"),
      userId: uid,
      channel: "onsite",
      modelId: 1,
      modelSnapshot: "unit-model",
      status: opts.status,
      attempts: opts.attempts ?? 0,
      lockedUntil: opts.lockedUntil ?? null,
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      payload: "{}",
    },
  });
}

async function makeMediaTask(opts: { status: string; attempts?: number; lockedUntil?: Date | null }) {
  const uid = await ensureUser();
  return db.playgroundMediaTask.create({
    data: {
      taskId: `mt-unit-${Date.now()}-${++seq}`,
      requestId: rid("mt"),
      userId: uid,
      kind: "image",
      modelId: 1,
      modelSnapshot: "unit-model",
      status: opts.status,
      attempts: opts.attempts ?? 0,
      lockedUntil: opts.lockedUntil ?? null,
      params: JSON.stringify({ prompt: "unit" }),
    },
  });
}

const future = () => new Date(Date.now() + 2 * 60_000);
const past = () => new Date(Date.now() - 60_000);

afterAll(async () => {
  if (userId) {
    await db.videoTask.deleteMany({ where: { userId } });
    await db.playgroundMediaTask.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } }).catch(() => {});
  }
  await db.$disconnect();
});

describe("claimVideoTask 租约抢占", () => {
  it("queued → 抢占成功，attempts+1、写 workerId 与租约", async () => {
    const t = await makeVideoTask({ status: "queued" });
    expect(await claimVideoTask(t.taskId)).toBe(true);
    const row = await db.videoTask.findUnique({ where: { taskId: t.taskId } });
    expect(row?.status).toBe("processing");
    expect(row?.attempts).toBe(1);
    expect(row?.workerId).toBe(VIDEO_WORKER_ID);
    expect(row?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  it("processing 但租约未过期 → 不许接管", async () => {
    const t = await makeVideoTask({ status: "processing", attempts: 1, lockedUntil: future() });
    expect(await claimVideoTask(t.taskId)).toBe(false);
    const row = await db.videoTask.findUnique({ where: { taskId: t.taskId } });
    expect(row?.attempts).toBe(1);
  });

  it("processing 且租约已过期 → 接管成功（崩溃遗留任务不再成孤儿）", async () => {
    const t = await makeVideoTask({ status: "processing", attempts: 1, lockedUntil: past() });
    expect(await claimVideoTask(t.taskId)).toBe(true);
    const row = await db.videoTask.findUnique({ where: { taskId: t.taskId } });
    expect(row?.attempts).toBe(2);
    expect(row?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  it("attempts 已达上限 → 不再接管（交由 reconciler 收口失败）", async () => {
    const t = await makeVideoTask({
      status: "processing",
      attempts: VIDEO_MAX_ATTEMPTS,
      lockedUntil: past(),
    });
    expect(await claimVideoTask(t.taskId)).toBe(false);
  });

  it("终态任务 → 不接管", async () => {
    const t = await makeVideoTask({ status: "succeeded" });
    expect(await claimVideoTask(t.taskId)).toBe(false);
  });
});

describe("claimMediaTask 租约抢占", () => {
  it("queued → 抢占成功", async () => {
    const t = await makeMediaTask({ status: "queued" });
    expect(await claimMediaTask(t.taskId)).toBe(true);
    const row = await db.playgroundMediaTask.findUnique({ where: { taskId: t.taskId } });
    expect(row?.status).toBe("running");
    expect(row?.attempts).toBe(1);
    expect(row?.workerId).toBe(MEDIA_WORKER_ID);
  });

  it("running 且租约未过期 → 不许接管", async () => {
    const t = await makeMediaTask({ status: "running", attempts: 1, lockedUntil: future() });
    expect(await claimMediaTask(t.taskId)).toBe(false);
  });

  it("running 且租约已过期 → 接管成功", async () => {
    const t = await makeMediaTask({ status: "running", attempts: 1, lockedUntil: past() });
    expect(await claimMediaTask(t.taskId)).toBe(true);
    const row = await db.playgroundMediaTask.findUnique({ where: { taskId: t.taskId } });
    expect(row?.attempts).toBe(2);
  });

  it("attempts 已达上限 → 不再接管", async () => {
    const t = await makeMediaTask({ status: "running", attempts: MEDIA_MAX_ATTEMPTS, lockedUntil: past() });
    expect(await claimMediaTask(t.taskId)).toBe(false);
  });
});
