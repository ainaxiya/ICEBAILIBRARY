#!/bin/bash
set -e
cd /www/wwwroot/CompletePrompt
echo "== 1. 解包 =="
tar -xzf /tmp/$1 2>/dev/null || echo "无代码包（纯构建/重启模式）"
echo "== 2. build (turbopack) =="
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=2048 npx next build --turbopack 2>&1 | tail -10
echo "== 3. pm2 restart & save =="
pm2 restart CompletePrompt
pm2 save
echo "== DONE =="