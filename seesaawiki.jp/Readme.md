# seesaawiki_scraper.py 说明

`seesaawiki_scraper.py` 用于抓取 SeesaaWiki 的月度页面，并自动生成对应的 Markdown 数据文件，同时更新月度索引 `monthly.json`。

## 脚本做了什么

1. 读取页面 URL（命令行参数或交互输入）。
2. 请求页面并按 `euc-jp` 编码解析 HTML。
3. 从页面标题提取月份，格式化为 `YYYY_MM`（例如 `2026~~4月 -> 2026_04`）。
4. 读取 `table#content_block_1` 表格，生成 Markdown 表格内容，字段包括：
   - 女友名
   - 出道作品封面
   - 作品海报
   - 女优详情链接（seesaawiki）
   - javbus 搜索链接
   - missav 搜索链接
5. 输出 Markdown 文件到 `html/md/{YYYY_MM}.md`。
6. 更新 `html/md/monthly.json`：
   - 在数组头部插入当前月份对象
   - 对同 `year_month` 做去重（保留最新）
   - `cover` 从本次抓取到的封面图里随机选一张

## `monthly.json` 新增对象格式

```json
{
  "year_month": "2026_04",
  "cover": "https://...jpg",
  "url": "/md/2026_04.md"
}
```

## 运行方式

```bash
python seesaawiki_scraper.py "<目标页面URL>"
```

或直接运行后手动输入 URL：

```bash
python seesaawiki_scraper.py
```

## 依赖

- `requests`
- `beautifulsoup4`

可通过项目内环境安装依赖后运行。
