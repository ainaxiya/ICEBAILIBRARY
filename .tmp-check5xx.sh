#!/bin/bash
LOG=/www/wwwlogs/wango8.com.log
echo "today_5xx=$(grep '19/Nov/2026' "$LOG" | awk '$9 ~ /^5/' | wc -l)"
echo "since_1216_5xx=$(grep -E '19/Nov/2026:12:(1[6-9]|[2-5][0-9]):' "$LOG" | awk '$9 ~ /^5/' | wc -l)"
echo "since_1216_total=$(grep -E '19/Nov/2026:12:(1[6-9]|[2-5][0-9]):' "$LOG" | wc -l)"
echo '--- last 3 5xx today ---'
grep '19/Nov/2026' "$LOG" | awk '$9 ~ /^5/' | tail -3
