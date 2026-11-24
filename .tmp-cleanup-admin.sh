#!/bin/bash
# 清理冒烟用临时管理员（先删日志避免外键残留）
set -uo pipefail
cd /www/wwwroot/CompletePrompt || exit 1
node - <<'JS'
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const a = await p.adminAccount.findUnique({ where: { username: 'smoke_v102' } });
  if (!a) { console.log('ADMIN_NOT_FOUND'); await p.$disconnect(); return; }
  const logs = await p.adminLog.deleteMany({ where: { adminId: a.id } });
  await p.adminAccount.delete({ where: { id: a.id } });
  console.log('DELETED admin=' + a.id + ' logs=' + logs.count);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
JS
rm -f /tmp/cp-ck.txt /tmp/cp-pricing.json
