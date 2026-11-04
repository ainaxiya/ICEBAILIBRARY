import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const admins = await db.adminAccount.findMany({ select: { id: true, username: true, status: true, isSuper: true } });
console.log("admins:", JSON.stringify(admins));
const keys = await db.vendorApiKey.findMany({ select: { id: true, name: true, keyPrefix: true, vendor: { select: { id: true, name: true, apiBase: true } } } });
console.log("keys:", JSON.stringify(keys));
const models = await db.aiModel.groupBy({ by: ["vendorId"], _count: true });
console.log("modelsByVendor:", JSON.stringify(models));
await db.$disconnect();
