#!/bin/bash
# 零停机发版：独立目录构建（不改动线上服务目录），成功后才允许替换
# 本机 7.8G 内存，默认 heap 会触发全局 OOM，构建期压到 2G 堆
set -uo pipefail

TS=$(date +%Y%m%d-%H%M%S)
B=/www/build-cp-$TS
LIVE=/www/wwwroot/CompletePrompt
echo "TS=$TS" > /tmp/cp-build-info
echo "BUILD_DIR=$B" >> /tmp/cp-build-info

# 清掉上一轮失败的构建目录，避免磁盘堆积
rm -rf /www/build-cp-*

mkdir -p "$B" || exit 1
rsync -a --exclude '.next' --exclude '.git' --exclude 'node_modules' \
  --exclude 'public' --exclude 'database' --exclude 'tsconfig.tsbuildinfo' \
  --exclude '.next.old-*' --exclude '.src.old-*' --exclude '.src.new-*' \
  "$LIVE/" "$B/" || exit 1
ln -s "$LIVE/public" "$B/public" || exit 1
cp -a /tmp/cp-v102/src/. "$B/src/" || exit 1
cp -a /tmp/cp-v102/package.json "$B/package.json" || exit 1
cp -al "$LIVE/node_modules" "$B/node_modules" || exit 1

cd "$B" || exit 1
NODE_OPTIONS="--max-old-space-size=3072" NEXT_TELEMETRY_DISABLED=1 npx next build > "/tmp/cp-build-$TS.log" 2>&1
RC=$?
echo "BUILD_RC=$RC"
tail -n 8 "/tmp/cp-build-$TS.log"

if [ "$RC" -ne 0 ] || [ ! -f "$B/.next/BUILD_ID" ]; then
  echo "BUILD_FAILED"
  exit 1
fi

echo "BUILD_ID=$(cat "$B/.next/BUILD_ID")"
if grep -rq "v1.0.2" "$B/.next/server/app" 2>/dev/null; then echo "VER_OK"; else echo "VER_MISSING"; fi
echo "BUILD_OK"
