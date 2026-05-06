# Ensure this script is run from the html directory.
if [ "$(basename "$PWD")" != "html" ]; then
  echo "需要在html目录执行server.sh"
  exit 1
fi

# npx serve . -l 3000

npx serve . -l 9202 --config .serve.json
