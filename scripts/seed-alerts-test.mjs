// 本地测试用：插入两条测试运营告警（仅本地库，勿在生产执行）
import { PrismaClient } from "@prisma/client";
const url = process.env.DATABASE_URL || "";
if (url.includes(":35432")) {
  console.error("[seed-alerts-test] 拒绝执行：DATABASE_URL 指向 35432（生产库）");
  process.exit(1);
}
const db = new PrismaClient();
try {
  const rows = await db.operationalAlert.createMany({
    data: [
      { alertType: "credit_pool", level: "warn", message: "本地测试告警1（积分池）", payload: "{\"test\":true}" },
      { alertType: "register_burst", level: "critical", message: "本地测试告警2（注册异常）", payload: "{\"test\":true}" },
    ],
  });
  console.log("inserted:", rows.count);
} finally {
  await db.$disconnect();
}
