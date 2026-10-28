#!/bin/bash
set -e
cd /www/wwwroot/CompletePrompt
echo "== 1. 解包 =="
tar -xzf /tmp/btn-crystal.tar.gz
echo "== 2. build =="
NEXT_TELEMETRY_DISABLED=1 npm run build 2>&1 | tail -10
echo "== 3. pm2 restart & save =="
pm2 restart CompletePrompt
pm2 save
echo "== DONE =="