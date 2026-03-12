#!/usr/bin/env python3
"""
从 seesaawiki.jp/md 目录下的每个 md 表格中随机选取一行，
生成包含 year_month、cover、url 的 JSON 文件。
"""
import json
import os
import random
import re
from pathlib import Path

MD_DIR = Path(__file__).parent / "md"
OUTPUT_JSON = Path(__file__).parent / "md/monthly.json"
GITHUB_RAW_BASE = "https://raw.githubusercontent.com/kkmike999/YouTube/refs/heads/main/seesaawiki.jp/md"


def extract_cover_url(cell_content: str) -> str | None:
    """从「出道作品封面」单元格提取图片 URL。优先 src，其次 href。"""
    if not cell_content or not cell_content.strip():
        return None
    # 尝试匹配 src="URL"
    m = re.search(r'src="([^"]+)"', cell_content)
    if m:
        return m.group(1)
    m = re.search(r'href="([^"]+\.(?:jpg|jpeg|png|gif|webp))"', cell_content, re.I)
    if m:
        return m.group(1)
    return None


def parse_md_table(content: str) -> list[dict]:
    """解析 markdown 表格，返回数据行列表。每行是列索引到内容的映射。"""
    lines = [l for l in content.strip().split("\n") if l.strip()]
    if len(lines) < 3:
        return []
    # 第一行表头，第二行分隔符，第三行起为数据
    data_rows = []
    for line in lines[2:]:
        if not line.startswith("|"):
            continue
        parts = [p.strip() for p in line.split("|")[1:-1]]  # 去掉首尾空
        if len(parts) >= 2:  # 至少需要 女友名、出道作品封面
            data_rows.append(parts)
    return data_rows


def process_md_file(md_path: Path) -> dict | None:
    """处理单个 md 文件，随机选一行，返回 {year_month, cover, url}。"""
    stem = md_path.stem  # 如 2025_07
    if not re.match(r"^\d{4}_\d{1,2}$", stem):
        return None

    content = md_path.read_text(encoding="utf-8")
    rows = parse_md_table(content)
    if not rows:
        return None

    # 过滤出有封面的行
    valid_rows = []
    for row in rows:
        if len(row) >= 2:
            cover = extract_cover_url(row[1])
            if cover:
                valid_rows.append(cover)

    if not valid_rows:
        return None

    cover = random.choice(valid_rows)
    md_filename = md_path.name
    md_github_url = f"{GITHUB_RAW_BASE}/{md_filename}"
    url = f"index.html?md={md_github_url}"

    return {
        "year_month": stem,
        "cover": cover,
        "url": url,
    }


def main():
    random.seed()
    results = []

    for md_path in sorted(MD_DIR.glob("*.md")):
        item = process_md_file(md_path)
        if item:
            results.append(item)

    # 按 year_month 排序（新的在前）
    results.sort(key=lambda x: x["year_month"], reverse=True)

    OUTPUT_JSON.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已生成 {OUTPUT_JSON}，共 {len(results)} 条")


if __name__ == "__main__":
    main()
