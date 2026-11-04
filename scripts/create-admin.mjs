// 用法: node scripts/create-admin.mjs <username> <password>
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();
const username = process.argv[2] || "admin";
const password = process.argv[3] || "admin123456";

async function main() {
  const hash = await bcrypt.hash(password, 10);
  const u = await db.user.upsert({
    where: { username },
    update: { role: "admin", passwordHash: hash, status: "active" },
    create: { username, passwordHash: hash, role: "admin", status: "active" },
  });
  // 后台登录走 admin_account 表（与会员 user 表完全分离），须同步建超级管理员
  const a = await db.adminAccount.upsert({
    where: { username },
    update: { passwordHash: hash, status: "active", isSuper: true },
    create: { username, passwordHash: hash, status: "active", isSuper: true },
  });
  console.log(`admin ready: user id=${u.id} adminAccount id=${a.id} username=${u.username} password=${password}`);
}
main().finally(() => db.$disconnect());
