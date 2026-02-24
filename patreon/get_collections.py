import os
import time
from playwright.sync_api import sync_playwright

def main():
    url = "https://www.patreon.com/cw/massagejp/collections"

    print(f"正在启动 Playwright 访问 {url} ...")
    
    with sync_playwright() as p:
        # 使用 Chromium 浏览器
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            locale="zh-CN"
        )
        page = context.new_page()
        
        try:
            # 访问页面，等待网络空闲
            page.goto(url, wait_until="networkidle")
            
            # 持续向下滚动以加载所有动态加载的合集
            print("正在向下滚动以加载更多内容...")
            last_height = page.evaluate("document.body.scrollHeight")
            while True:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                time.sleep(2)  # 等待加载
                new_height = page.evaluate("document.body.scrollHeight")
                if new_height == last_height:
                    break
                last_height = new_height
                
            # 等待我们需要的元素加载出来
            print("等待合集元素加载...")
            try:
                page.wait_for_selector('a[data-tag="box-collection-title-href"]', timeout=5000)
            except Exception as e:
                print(f"等待合集链接超时或发生错误: {e}")

            # 直接获取所有的合集链接 a 标签
            items = page.locator('a[data-tag="box-collection-title-href"]').all()
            
            if not items:
                print("未找到包含合集的元素。请检查页面结构是否已更改或是否有反爬虫弹窗。")
                browser.close()
                return

            results = []
            print(f"找到 {len(items)} 个合集，开始解析...")

            for a_locator in items:
                href = a_locator.get_attribute("href") or ""
                if href.startswith("/"):
                    href = "https://www.patreon.com" + href
                
                # strong 标签通常就在 a 标签内部
                strong_locator = a_locator.locator('strong[data-tag="box-collection-title"]')
                if strong_locator.count() > 0:
                    title = strong_locator.first.inner_text().strip()
                else:
                    title = a_locator.inner_text().strip()
                    
                if title:
                    results.append((title, href))
            
            # 写入 markdown 表格
            if results:
                os.makedirs("./temp", exist_ok=True)
                md_file = "./temp/合集.md"
                
                with open(md_file, "w", encoding="utf-8") as f:
                    f.write("| 标题 | 链接 | 下载合集 |\n")
                    f.write("| --- | --- | --- |\n")
                    for title, href in results:
                        cmd = f"`python download_patreon_collection.py {href}`"
                        f.write(f"| {title} | {href} | {cmd} |\n")
                        
                print(f"提取成功！共获取 {len(results)} 个合集，已保存至 {md_file}")
            else:
                print("未提取到有效的标题和链接。")

        except Exception as e:
            print(f"页面访问或解析错误: {e}")
            
        finally:
            browser.close()

if __name__ == "__main__":
    main()
