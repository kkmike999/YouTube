import json
import time
from pathlib import Path


class ExploreReelsFileWriter:
    """封装 Explore Reels 脚本里的所有调试文件写入逻辑。"""

    def __init__(self, temp_dir="temp"):
        self.temp_dir = Path(temp_dir)
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    def save_explore_page_html(self, page_content):
        html_path = self.temp_dir / f"explore_page_{int(time.time())}.html"
        html_path.write_text(page_content, encoding="utf-8")
        print(f"已保存 Explore 页面 HTML: {html_path.resolve()}")
        return html_path

    def save_aagu_items_dump(self, aagu_items):
        aagu_dump = []
        for index, item in enumerate(aagu_items, start=1):
            try:
                outer_html = item.evaluate("el => el.outerHTML")
            except Exception as exc:
                outer_html = f"<读取失败: {exc}>"
            aagu_dump.append(
                {
                    "index": index,
                    "outer_html": outer_html,
                }
            )

        aagu_dump_path = self.temp_dir / f"aagu_items_{int(time.time())}.json"
        aagu_dump_path.write_text(
            json.dumps(aagu_dump, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"已保存 aagu_items 内容: {aagu_dump_path.resolve()}")
        return aagu_dump_path

    def init_aagu_parent_div_dump_file(self):
        parent_dump_path = self.temp_dir / f"aagu_parent_div_{int(time.time())}.jsonl"
        parent_dump_path.write_text("", encoding="utf-8")
        print(f"已创建 aagu_parent_div 调试文件: {parent_dump_path.resolve()}")
        return parent_dump_path

    def append_aagu_parent_div_dump(self, parent_dump_path, item):
        with parent_dump_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
