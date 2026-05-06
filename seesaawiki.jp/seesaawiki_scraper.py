import os
import re
import sys
import json
import random
from urllib.parse import urlencode, quote

import requests
from bs4 import BeautifulSoup

def clean_cell_html(cell):
    """清洗表格单元格 HTML，便于安全写入 Markdown 表格。"""
    # Decode contents, replace newlines with space, and escape | for markdown
    html = str(cell.decode_contents())
    html = html.replace('\n', ' ').replace('\r', '')
    html = html.replace('|', '&#124;')
    return html.strip()


def update_monthly_json(md_dir, year_month, cover_candidates, md_filename):
    """更新 monthly.json：若不存在同 year_month，则插入到数组头部。"""
    # monthly.json 固定保存在 md 目录中
    monthly_json_path = os.path.join(md_dir, "monthly.json")

    # 组装本次新增项，封面从本次抓取到的候选图中随机选一张
    new_item = {
        "year_month": year_month,
        "cover": random.choice(cover_candidates) if cover_candidates else "",
        "url": f"/md/{md_filename}"
    }

    # 读取旧数据；若文件不存在或内容异常，则从空数组开始
    monthly_data = []
    if os.path.exists(monthly_json_path):
        try:
            with open(monthly_json_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, list):
                monthly_data = loaded
        except (json.JSONDecodeError, OSError):
            monthly_data = []

    # 若已存在同 year_month，则不做任何写操作
    for item in monthly_data:
        if isinstance(item, dict) and item.get("year_month") == year_month:
            return False

    # 新数据插入数组首位，确保最新月份优先展示
    monthly_data.insert(0, new_item)

    # 回写 monthly.json（UTF-8 + 美化缩进）
    with open(monthly_json_path, "w", encoding="utf-8") as f:
        json.dump(monthly_data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    return True

def main():
    """抓取 SeesaaWiki 月度页面，生成 Markdown，并同步更新 monthly.json。"""
    # 1) 解析输入参数：优先使用命令行 URL，没有则交互输入
    if len(sys.argv) < 2:
        print("Usage: python seesaawiki_scraper.py <url>")
        url = input("请输入 URL: ").strip()
        if not url:
            print("未输入 URL，退出。")
            return
    else:
        url = sys.argv[1]

    # 2) 请求并解析页面（页面编码为 euc-jp）
    print(f"Fetching {url}")
    response = requests.get(url)
    response.encoding = 'euc-jp'
    soup = BeautifulSoup(response.text, 'html.parser')

    # 1. 标题
    title_node = soup.select_one('div.title h2')
    if not title_node:
        print("Could not find title node.")
        page_title = "未知标题"
    else:
        page_title = title_node.text.strip()
    
    # 例如 "2026~~4月" -> "2026_04"
    normalized_title = re.sub(
        r'^(\d{4})~~(\d{1,2})月$',
        lambda m: f"{m.group(1)}_{int(m.group(2)):02d}",
        page_title
    )

    # Sanitize title for filename
    safe_title = re.sub(r'[\\/*?:"<>|]', "", normalized_title)
    print(f"Title processing: '{page_title}' -> '{safe_title}'")
    
    # 4) 提取目标表格并转换成 Markdown 行
    table = soup.find('table', id='content_block_1')
    if not table:
        print("Could not find table #content_block_1")
        return

    md_lines = []
    # 6. 生成新markdown表格：女友名、出道作品封面、作品海报、女优详情链接；
    md_lines.append("| 女友名 | 出道作品封面 | 作品海报 | 女优详情链接 | javbus | missav | ")
    md_lines.append("| --- | --- | --- | --- | --- | --- |")
    
    # 收集封面候选图，用于 monthly.json 随机封面
    cover_candidates = []
    rows = table.find_all('tr')
    for row in rows:
        cols = row.find_all(['th', 'td'])
        if len(cols) < 5:
            continue
        
        # 3. 第一列女优信息，获取<td>第一行text
        col0_text_nodes = list(cols[0].stripped_strings)
        actress_name = col0_text_nodes[0] if col0_text_nodes else ""
        actress_name = actress_name.replace('|', '&#124;')
        
        # 提取出道作品封面(Col 1)和作品海报(Col 2)
        # 用html格式保持图片形式
        cover_html = clean_cell_html(cols[1])
        poster_html = clean_cell_html(cols[2])
        cover_img = cols[1].find("img")
        if cover_img and cover_img.get("src"):
            cover_candidates.append(cover_img.get("src").strip())
        
        # 4. 第5列"详情链接"，获取第3个href“女优详情链接”
        col4_links = cols[4].find_all('a', href=True)
        actress_link = ""
        if len(col4_links) >= 3:
            actress_link = col4_links[2].get('href', "")
        
        if not actress_name and not actress_link and not cover_html and not poster_html:
            continue
            
        # Add to markdown
        javbus_link = f"https://www.javbus.com/search/{actress_name}"
        missav_link = f"https://missav.live/search/{actress_name}"
        url_params = {
            'aid': 1,
            'cid': 428291345258651724,
            'old_cid': 428291345258651724,
            'old_cid_name': 'A______',
            'search_value': actress_name,
            'ct': 'file',
            'ac': 'search',
            'is_wl_tpl': 1,
        }
        # url_param_value = urlencode(url_params)
        # _115_link = f"https://115.com/?submode=wangpan&mode=search&url={quote(url_param_value, safe='')}"
        md_lines.append(f"| {actress_name} | {cover_html} | {poster_html} | [seesaawiki]({actress_link}) | [javbus]({javbus_link}) | [missav]({missav_link}) | ")
        
    # 5) 写出 Markdown 文件
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "html\\md")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{safe_title}.md")
    
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write("\n".join(md_lines) + "\n")

    # 6) 同步更新 monthly.json 前先让用户确认
    confirm_update = input("是否更新 monthly.json？[y/N]: ").strip().lower()
    if confirm_update in ("y", "yes"):
        updated = update_monthly_json(
            md_dir=out_dir,
            year_month=safe_title,
            cover_candidates=cover_candidates,
            md_filename=os.path.basename(out_path)
        )
        if updated:
            print(f"Updated monthly json: {os.path.join(out_dir, 'monthly.json')}")
        else:
            print(f"monthly.json 已存在 year_month={safe_title}，未做更新。")
    else:
        print("已跳过更新 monthly.json。")
        
    print(f"Successfully generated markdown at: {out_path}")

if __name__ == "__main__":
    main()
