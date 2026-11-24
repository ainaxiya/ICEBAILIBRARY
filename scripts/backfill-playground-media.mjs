// 一次性回填：把修复前产生的媒体任务补写进会话消息，并补登本地产物的资产记录。
// 幂等：已有 taskId 关联的消息 / 同 storageKey 的资产不会重复写入。
import { PrismaClient } from "@prisma/client";
import { stat } from "node:fs/promises";
import path from "node:path";

const db = new PrismaClient();
const PUBLIC_DIR = process.env.UPLOAD_PUBLIC_DIR || "/www/wwwroot/CompletePrompt/public";

function localFileOf(url) {
  return url.startsWith("/uploads/") ? path.join(PUBLIC_DIR, url.replace(/^\//, "")) : null;
}

async function localSize(url) {
  const file = localFileOf(url);
  if (!file) return 0n;
  try {
    return BigInt((await stat(file)).size);
  } catch {
    return 0n;
  }
}

function parseUrls(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

const tasks = await db.playgroundMediaTask.findMany({
  where: { userId: { gt: 0 } },
  orderBy: { createdAt: "asc" },
});

let sessions = 0;
let assets = 0;

for (const t of tasks) {
  // 任务表不存 prompt（隐私），但 params 快照里有；用它恢复会话标题与用户消息
  let prompt = "";
  try {
    const parsed = JSON.parse(t.params || "{}");
    if (parsed && typeof parsed.prompt === "string") prompt = parsed.prompt;
  } catch {
    /* 忽略脏数据 */
  }

  const linked = await db.playgroundMessage.findFirst({
    where: { taskId: t.taskId },
    select: { id: true, sessionId: true },
  });

  if (linked) {
    // 兼容上一次回填写空的记录：只补空内容，不覆盖已有正文
    if (prompt) {
      await db.playgroundMessage.updateMany({
        where: { sessionId: linked.sessionId, role: "user", content: "" },
        data: { content: prompt },
      });
      const s = await db.playgroundSession.findUnique({
        where: { id: linked.sessionId },
        select: { title: true },
      });
      if (s && (s.title === "媒体生成" || !s.title)) {
        await db.playgroundSession.update({
          where: { id: linked.sessionId },
          data: { title: prompt.replace(/\s+/g, " ").trim().slice(0, 40) || "媒体生成" },
        });
      }
    }
  } else {
    const finished = t.finishedAt ?? t.createdAt;
    const title = (prompt || "媒体生成").replace(/\s+/g, " ").trim().slice(0, 40) || "媒体生成";
    const content =
      t.status === "succeeded"
        ? `已完成${t.requestSize ? ` · ${t.requestSize}` : ""}`
        : t.errorMessage || "生成失败，预扣积分已退回";
    const session = await db.playgroundSession.create({
      data: {
        userId: t.userId,
        title,
        modelName: t.modelSnapshot,
        createdAt: t.createdAt,
        updatedAt: finished,
      },
      select: { id: true },
    });
    await db.playgroundMessage.createMany({
      data: [
        { sessionId: session.id, role: "user", content: prompt, createdAt: t.createdAt },
        {
          sessionId: session.id,
          role: "assistant",
          content,
          taskId: t.taskId,
          createdAt: finished,
        },
      ],
    });
    sessions++;
    console.log(`[backfill] session ${session.id} <- task ${t.taskId} (${t.status})`);
  }

  if (t.status === "succeeded") {
    for (const url of parseUrls(t.resultUrls)) {
      if (!url.startsWith("/uploads/")) continue;
      const exists = await db.generatedAsset.findFirst({
        where: { userId: t.userId, storageKey: url },
        select: { id: true, sizeBytes: true },
      });
      const size = await localSize(url);
      if (exists) {
        if (exists.sizeBytes === 0n && size > 0n) {
          await db.generatedAsset.update({ where: { id: exists.id }, data: { sizeBytes: size } });
        }
        continue;
      }
      await db.generatedAsset.create({
        data: {
          userId: t.userId,
          assetType: t.kind === "video" ? "video" : "image",
          storageKey: url,
          sizeBytes: size,
          status: "temp",
          expireAt: new Date(Date.now() + 30 * 86400000),
          createdAt: t.finishedAt ?? t.createdAt,
        },
      });
      assets++;
      console.log(`[backfill] asset <- ${url}`);
    }
  }
}

console.log(`[backfill] done: sessions=${sessions}, assets=${assets}`);
await db.$disconnect();
