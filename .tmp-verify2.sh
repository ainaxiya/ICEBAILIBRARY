#!/bin/bash
set -uo pipefail
BASE=http://127.0.0.1:3000
PSQL="docker exec -i postgresql_18_kpjt-postgresql_18_kpJt-1 psql -U woshizhou -d prompthub -tA"
MID=$($PSQL -c "select id from ai_model where name like 'doubao-seedance-2-0-260128%' order by id limit 1" | tr -d ' \r\n')
echo "MODEL_ID_2_0=$MID"
curl -sS -b /tmp/cp-ck.txt "$BASE/api/admin/models/models/$MID/pricing" > /tmp/cp-pricing2.json
node - <<'JS'
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('/tmp/cp-pricing2.json', 'utf8'));
if (!d.pricings) { console.log('API_FAIL=' + JSON.stringify(d)); process.exit(2); }
const seen = new Set(); const out = [];
for (const p of d.pricings) {
  if (p.unit !== 'video_second') continue;
  const k = p.variant || 'GENERIC';
  if (seen.has(k)) continue;
  seen.add(k);
  out.push(`${k}=${p.inputPrice}/${p.memberInputPrice ?? 'NULL'}`);
}
out.sort(); console.log('API_ROWS=' + out.length); console.log(out.join('\n'));
JS
echo '--- DB expected ---'
$PSQL <<SQL
select distinct on (variant) coalesce(nullif(variant,''),'GENERIC') || '=' || "inputPrice"::float8 || '/' || coalesce("memberInputPrice"::float8::text,'NULL')
from model_pricing where "modelId"=$MID and unit='video_second'
order by variant, "effectiveAt" desc;
SQL
echo '--- version in live html ---'
curl -s --max-time 20 https://www.icebai.com/ | grep -o 'v1\.0\.[0-9]' | head -1
echo '--- log growth ---'
cat /tmp/cp-log-base
stat -c '%s %n' /root/.pm2/logs/CompletePrompt-err.log /root/.pm2/logs/CompletePrompt-out.log
echo '--- err.log new lines since restart ---'
tail -n 30 /root/.pm2/logs/CompletePrompt-err.log
