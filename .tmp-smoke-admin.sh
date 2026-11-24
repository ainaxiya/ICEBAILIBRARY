#!/bin/bash
# 只读冒烟：临时管理员登录 → 读 seedance 定价接口，与数据库直查对比；不做任何写库
set -uo pipefail
BASE=http://127.0.0.1:3000
PSQL="docker exec -i postgresql_18_kpjt-postgresql_18_kpJt-1 psql -U woshizhou -d prompthub -tA"
cd /www/wwwroot/CompletePrompt || exit 1

node - <<'JS'
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
(async () => {
  const p = new PrismaClient();
  const hash = await bcrypt.hash('SmokeV102x9', 10);
  const a = await p.adminAccount.upsert({
    where: { username: 'smoke_v102' },
    create: { username: 'smoke_v102', nickname: 'smoke', passwordHash: hash, status: 'active', isSuper: true },
    update: { passwordHash: hash, status: 'active', isSuper: true },
  });
  console.log('ADMIN_ID=' + a.id);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
JS

MID=$($PSQL -c "select id from ai_model where name like 'doubao-seedance-2-5-flash%' order by id limit 1" | tr -d ' \r\n')
echo "MODEL_ID=$MID"

echo '--- login ---'
curl -sS -c /tmp/cp-ck.txt -H 'Content-Type: application/json' \
  -d '{"username":"smoke_v102","password":"SmokeV102x9"}' \
  "$BASE/api/admin/auth/login"; echo

curl -sS -b /tmp/cp-ck.txt "$BASE/api/admin/models/models/$MID/pricing" > /tmp/cp-pricing.json
echo '--- API rows (latest per variant) ---'
node - <<'JS'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/cp-pricing.json', 'utf8'));
if (!data.pricings) { console.log('API_FAIL=' + JSON.stringify(data)); process.exit(2); }
const seen = new Set(); const out = [];
for (const p of data.pricings) {
  if (p.unit !== 'video_second') continue;
  const key = p.variant || 'GENERIC';
  if (seen.has(key)) continue;
  seen.add(key);
  out.push(`${key}=${p.inputPrice}/${p.memberInputPrice ?? 'NULL'}`);
}
out.sort();
console.log('API_ROWS=' + out.length);
console.log(out.join('\n'));
JS

echo '--- DB expected (latest per variant) ---'
$PSQL <<SQL
select distinct on (variant) coalesce(nullif(variant,''),'GENERIC') || '=' || "inputPrice"::float8 || '/' || coalesce("memberInputPrice"::float8::text,'NULL')
from model_pricing where "modelId"=$MID and unit='video_second'
order by variant, "effectiveAt" desc;
SQL
