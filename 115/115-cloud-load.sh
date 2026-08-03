#!/bin/bash

if [ "${PWD##*/}" = "115" ]; then
  cd .. || exit 1
fi

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

  if [[ "$code" == [Ff][Cc]2* ]]; then
    if ! jav_json=$(node heimacili/heimacili_search.js --keyword "$code"); then
      echo ">>> 获取番号数据失败，跳过: $code" >&2
      continue
    fi
  else
    if ! jav_json=$(node jav/jav_magnet.js --番号 "$code"); then
      echo ">>> jav_magnet 获取失败，改用 heimacili 搜索: $code" >&2
      if ! jav_json=$(node heimacili/heimacili_search.js --keyword "$code"); then
        echo ">>> 获取番号数据失败，跳过: $code" >&2
        continue
      fi
    fi
  fi
  if [ -z "$jav_json" ]; then
    echo ">>> 番号数据为空，跳过: $code" >&2
    continue
  fi

  if ! jav_json_type=$(printf '%s' "$jav_json" | jq -r 'type'); then
    echo ">>> 番号数据不是有效的 JSON，跳过: $code" >&2
    continue
  fi

  case "$jav_json_type" in
    array)
      if ! jav_json=$(printf '%s' "$jav_json" | jq -c '.[0]'); then
        echo ">>> 无法获取番号数据的第一个元素，跳过: $code" >&2
        continue
      fi
      ;;
    object)
      ;;
    *)
      echo ">>> 番号数据必须是 JSON array 或 JSON object，跳过: $code" >&2
      continue
      ;;
  esac

  # jav_json
  #  [
  #    {
  #      "code": "300MIUM-1395",
  #      "title": "300MIUM-1395 スケベ顔で迫る変態ジト目ま◯こww本人はSに見られるって言ってるけど、目がもうドMの瞳してるんよね。「挿れて…くれるよね？」期待でいっぱいのイヤらしい目つきで御法度チ◯ポおねだりww待望の挿入でグネグネと止まらない腰。。ドMの女って騎乗位慣れてるよなww ：file.43",
  #      "url": "https://www.javbus.com/300MIUM-1395",
  #      "magnet": {
  #        "name": "第一會所新片@SIS001@300MIUM-1395",
  #        "size": "5.25GB",
  #        "sizeBytes": 5637144576,
  #        "date": "2026-07-09",
  #        "link": "magnet:?xt=urn:btih:19b5a828bce9040b3ac6de839f79acb151d6a812&dn=%E7%AC%AC%E4%B8%80%E6%9C%83%E6%89%80%E6%96%B0%E7%89%87%40SIS001%40300MIUM-1395"
  #      }
  #    }
  #  ]

  node 115/115-cloud-load.js --code "$code" --jav-json "$jav_json"
done
