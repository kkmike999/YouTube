import os
import requests
from bs4 import BeautifulSoup
import re
import sys

def clean_cell_html(cell):
    # Decode contents, replace newlines with space, and escape | for markdown
    html = str(cell.decode_contents())
    html = html.replace('\n', ' ').replace('\r', '')
    html = html.replace('|', '&#124;')
    return html.strip()

def main():
    if len(sys.argv) < 2:
        print("Usage: python seesaawiki_scraper.py <url>")
        return
    url = sys.argv[1]
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
    
    # Sanitize title for filename
    safe_title = re.sub(r'[\\/*?:"<>|]', "", page_title)
    print(f"Title processing: '{page_title}' -> '{safe_title}'")
    
    # 2. 表格内容转换
    table = soup.find('table', id='content_block_1')
    if not table:
        print("Could not find table #content_block_1")
        return

    md_lines = []
    # 6. 生成新markdown表格：女友名、出道作品封面、作品海报、女优详情链接；
    md_lines.append("| 女友名 | 出道作品封面 | 作品海报 | 女优详情链接 | javbus |")
    md_lines.append("| --- | --- | --- | --- | --- |")
    
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
        
        # 4. 第5列"详情链接"，获取第3个href“女优详情链接”
        col4_links = cols[4].find_all('a', href=True)
        actress_link = ""
        if len(col4_links) >= 3:
            actress_link = col4_links[2].get('href', "")
        
        if not actress_name and not actress_link and not cover_html and not poster_html:
            continue
            
        # Add to markdown
        javbus_link = f"https://www.javbus.com/search/{actress_name}"
        md_lines.append(f"| {actress_name} | {cover_html} | {poster_html} | {actress_link} | {javbus_link} |")
        
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{safe_title}.md")
    
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write("\n".join(md_lines) + "\n")
        
    print(f"Successfully generated markdown at: {out_path}")

if __name__ == "__main__":
    main()
