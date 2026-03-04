"""
从 JAVBus 获取番号对应的磁力链，输出 markdown 表格。
用法: python jav_magnet.py --番号 SONE-930
       python jav_magnet.py --番号 SONE-930 ABC-123  （可指定多个番号）
       python jav_magnet.py  （无参数时提示输入番号）
"""
import argparse
import re
import sys
from pathlib import Path

# 确保能导入同目录的 jav_scraper
sys.path.insert(0, str(Path(__file__).resolve().parent))
from jav_scraper import extract_code, get_jav_info


def parse_args():
    parser = argparse.ArgumentParser(description='JAV 磁力链查询 - 输出到命令行')
    parser.add_argument('--番号', nargs='*', dest='codes', help='番号，可指定多个。未指定时将在运行时提示输入')
    return parser.parse_args()


def main():
    args = parse_args()

    codes = []
    if args.codes:
        for arg in args.codes:
            code = extract_code(arg)
            if code:
                codes.append(code)
    else:
        user_input = input("请输入番号: ").strip()
        if user_input:
            # 支持一行输入多个番号（空格或逗号分隔）
            codes = re.findall(r'[A-Za-z]+-\d+', user_input)

    if not codes:
        print("错误：未提取到有效番号。")
        return

    # 构建 markdown 表格
    lines = [
        "| 番号 | 标题 | 磁力链目录名 | 大小 | 日期 | 磁力链 |",
        "| -- | -- | -- | -- | -- | -- |",
    ]
    for code in codes:
        title, url, magnet = get_jav_info(code)
        if magnet:
            name = magnet['name']
            size_str = magnet['size_str']
            date_str = magnet['date']
            link = magnet['link']
        else:
            name = size_str = date_str = link = "未找到"
        title_esc = title.replace("|", "\\|")
        lines.append(f"| {code} | {title_esc} | {name} | {size_str} | {date_str} | {link} |")

    # 输出到命令行
    for line in lines:
        print(line)

    # 写入 temp/${番号}.md
    out_path = Path(__file__).resolve().parent / "temp" / f"{code}.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n已写入: {out_path}")


if __name__ == "__main__":
    main()
