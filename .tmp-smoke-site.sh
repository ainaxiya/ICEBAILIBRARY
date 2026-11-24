#!/bin/bash
# 站点可用性与鉴权前置冒烟（只读）
set -uo pipefail
S=https://www.icebai.com
A=https://api.icebai.com

echo '=== pages (follow redirect) ==='
for p in / /login /register /credit-rules /playground; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 25 "$S$p")
  echo "$p -> $code"
done

echo '=== unauth redirect (no follow) ==='
for p in /member /guanli-7k2m9x; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 25 "$S$p")"
done

echo '=== /v1 auth ==='
for spec in "GET /v1/models" "POST /v1/chat/completions" "POST /v1/videos" "POST /v1/audio/speech"; do
  m=${spec%% *}; u=${spec#* }
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$m" -H 'Content-Type: application/json' -d '{}' --max-time 25 "$A$u")
  echo "$m $u -> $code"
done
