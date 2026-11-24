#!/bin/bash
# 原子替换产物 + 同步源码 + 修属主 + 重启（构建已在独立目录完成）
set -euo pipefail
source /tmp/cp-build-info   # TS=... BUILD_DIR=...
LIVE=/www/wwwroot/CompletePrompt
B="$BUILD_DIR"

[ -n "${B:-}" ] && [ -f "$B/.next/BUILD_ID" ] || { echo "NO_BUILD"; exit 1; }
NEW_ID=$(cat "$B/.next/BUILD_ID")
echo "NEW_BUILD_ID=$NEW_ID"

# 发版前日志基线
stat -c '%s %n' /root/.pm2/logs/CompletePrompt-err.log /root/.pm2/logs/CompletePrompt-out.log > /tmp/cp-log-base 2>/dev/null || true
cat /tmp/cp-log-base

OLD="$LIVE/.next.old-$TS"
mv "$LIVE/.next" "$OLD"
mv "$B/.next" "$LIVE/.next"

# 同步源码与版本文件（逐文件临时名 + mv，避免半写）
mkdir -p "$LIVE/src/lib/admin"
for f in src/lib/admin/video-pricing.ts src/components/admin/ModelLibrary.tsx src/lib/version.ts package.json; do
  cp -a "/tmp/cp-v102/$f" "$LIVE/$f.tmp-$TS"
  mv "$LIVE/$f.tmp-$TS" "$LIVE/$f"
done

chown -R www:www "$LIVE/.next"
chown www:www "$LIVE/src/lib/admin/video-pricing.ts" "$LIVE/src/components/admin/ModelLibrary.tsx" "$LIVE/src/lib/version.ts" "$LIVE/package.json"

# 只保留最近一份 .next 备份
ls -d "$LIVE"/.next.old-* 2>/dev/null | sort | head -n -1 | xargs -r rm -rf
ls -d "$LIVE"/.next.old-* 2>/dev/null || true

pm2 restart CompletePrompt >/dev/null
sleep 4
pm2 ls | sed -n '1,8p'
echo "DEPLOY_OK"
