#!/bin/bash
# 用户输入的参数，支持多个番号
codes=("$@")

if [ ${#codes[@]} -eq 0 ]; then
  echo "请输入番号，例如: ABC-123 或 ABC-123 DEF-456"
  read -r input
  if [ -z "$input" ]; then
    echo "番号不能为空"
    exit 1
  fi
  # 按空格分割为数组
  read -ra codes <<< "$input"
fi

for code in "${codes[@]}"; do
  # 去掉多余空格
  code=$(echo "$code" | sed 's/ //g')
  [ -z "$code" ] && continue

  echo ">>> 处理番号: $code"
  python ../jav/jav_magnet.py --番号 "$code"
  python ../115/115-cloud-load.py --番号 "$code"
done