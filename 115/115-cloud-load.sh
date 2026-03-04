
# 用户输入的参数
code=$1

if [ -z "$code" ]; then
  echo "请输入番号，例如: ABC-123"
  read -r code
  if [ -z "$code" ]; then
    echo "番号不能为空"
    exit 1
  fi
fi

# code去掉多余空格
code=$(echo "$code" | sed 's/ //g')

python ../jav/jav_magnet.py --番号 "$code"
python ../115/115-cloud-load.py --番号 "$code"