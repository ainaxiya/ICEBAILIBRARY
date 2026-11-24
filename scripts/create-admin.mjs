// 用法: node scripts/create-admin.mjs <username> <password>
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();
const username = process.argv[2] || "admin";
const password = process.argv[3] || "admin123456";

async function main() {
  const hash = await bcrypt.hash(password, 10);
  // 后台登录走 admin_account 表（与会员 user 表完全分离），不再在 User 表写历史管理员行
  const a = await db.adminAccount.upsert({
    where: { username },
    update: { passwordHash: hash, status: "active", isSuper: true },
    create: { username, passwordHash: hash, status: "active", isSuper: true },
  });
  console.log(`admin ready: adminAccount id=${a.id} username=${a.username} password=${password}`);
}
main().finally(() => db.$disconnect());
