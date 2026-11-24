-- 冰山实验场 M2：会话与消息表（仅新增，不改动既有表）
-- 与 prisma/schema.prisma 中 PlaygroundSession / PlaygroundMessage 对应
CREATE TABLE IF NOT EXISTS "playground_session" (
  "id"         SERIAL PRIMARY KEY,
  "userId"     INTEGER NOT NULL,
  "title"      TEXT NOT NULL DEFAULT '新对话',
  "modelName"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "playground_session_userId_updatedAt_idx"
  ON "playground_session" ("userId", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS "playground_message" (
  "id"           SERIAL PRIMARY KEY,
  "sessionId"    INTEGER NOT NULL,
  "role"         TEXT NOT NULL,
  "content"      TEXT NOT NULL,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "playground_message_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "playground_session"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "playground_message_sessionId_createdAt_idx"
  ON "playground_message" ("sessionId", "createdAt");
