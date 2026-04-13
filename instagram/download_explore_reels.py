import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from download_video import download_instagram_video
from explore_reels_file_writer import ExploreReelsFileWriter
from instagram_cookies_loader import load_playwright_cookies_from_netscape

try:
    from playwright_stealth import Stealth
except Exception:
    Stealth = None

try:
    from playwright_stealth import stealth_sync
except Exception:
    stealth_sync = None


def normalize_instagram_url(href):
    """把相对链接统一补全为 Instagram 绝对链接。"""
    if not href:
        return None
    if href.startswith("http://") or href.startswith("https://"):
        return href
    if not href.startswith("/"):
        href = "/" + href
    return f"https://www.instagram.com{href}"


def collect_explore_reels_urls(page, file_writer):
    """抓取 Explore 页中当前首屏可见的 Reels 链接。"""
    page.goto("https://www.instagram.com/explore/", wait_until="domcontentloaded")

    file_writer.save_explore_page_html(page.content())

    page.wait_for_selector("div._aagu", timeout=20000)
    time.sleep(2)

    urls = []
    seen = set()
    aagu_items = page.locator("div._aagu").all()
    # file_writer.save_aagu_items_dump(aagu_items)
    parent_dump_path = file_writer.init_aagu_parent_div_dump_file()

    for index, aagu_div in enumerate(aagu_items, start=1):
        # _aagu 是媒体容器，父级一般包含跳转链接和媒体类型标识。
        aagu_parent_div = aagu_div.locator("xpath=..")
        try:
            parent_outer_html = aagu_parent_div.evaluate("el => el.outerHTML")
        except Exception as exc:
            parent_outer_html = f"<读取失败: {exc}>"
        file_writer.append_aagu_parent_div_dump(
            parent_dump_path,
            {
                "index": index,
                "stage": "parent_outer_html_captured",
                "outer_html": parent_outer_html,
            },
        )

        try:
            # parent 通常就是 <a>，优先读取自身 href，避免在其内部再找 a[href] 导致超时。
            href = aagu_parent_div.get_attribute("href", timeout=2000)
            if not href:
                href = aagu_parent_div.locator("a[href]").first.get_attribute(
                    "href", timeout=2000
                )
        except Exception as exc:
            file_writer.append_aagu_parent_div_dump(
                parent_dump_path,
                {
                    "index": index,
                    "stage": "href_read_error",
                    "error": str(exc),
                    "outer_html": parent_outer_html,
                },
            )
            print(f"读取 href 失败，index={index}: {exc}")
            continue
        file_writer.append_aagu_parent_div_dump(
            parent_dump_path,
            {
                "index": index,
                "stage": "href_read_ok",
                "href": normalize_instagram_url(href) if href else None,
            },
        )
        if not href:
            continue

        sibling_divs = aagu_parent_div.locator("xpath=./div")
        if sibling_divs.count() <= 1:
            continue

        # 找到兄弟节点里“不是 _aagu 本体”的那个 div，通常承载 Reels 图标。
        aagu_next = None
        for i in range(sibling_divs.count()):
            candidate_div = sibling_divs.nth(i)
            class_name = candidate_div.get_attribute("class") or ""
            if "_aagu" not in class_name.split():
                aagu_next = candidate_div
                break

        if aagu_next is None:
            continue

        # 只保留带 Reels 标识的条目，排除图片/普通帖子。
        if aagu_next.locator('svg[aria-label="Reels"]').count() == 0:
            continue

        full_url = normalize_instagram_url(href)
        if not full_url or full_url in seen:
            continue

        seen.add(full_url)
        urls.append(full_url)

    return urls


def apply_playwright_stealth(context, page):
    """兼容不同 playwright_stealth 版本，优先 context 注入，失败再回退 page 注入。"""
    if Stealth is None and stealth_sync is None:
        raise ImportError("未安装 playwright_stealth，请先执行: pip install playwright-stealth")

    if Stealth is not None:
        try:
            stealth = Stealth(init_scripts_only=True)
        except TypeError:
            stealth = Stealth()

        try:
            stealth.apply_stealth_sync(context)
            print("已启用 playwright_stealth: Stealth.apply_stealth_sync(context)")
            return
        except Exception as exc:
            print(f"Stealth.apply_stealth_sync(context) 失败，尝试回退 stealth_sync(page): {exc}")

    if stealth_sync is None:
        raise RuntimeError("playwright_stealth 可用，但未找到可调用的 stealth 接口。")

    stealth_sync(page)
    print("已启用 playwright_stealth: stealth_sync(page)")


def main():
    """入口：加载 cookies -> 抓取 Reels URL -> 调用下载器逐条下载。"""
    script_dir = Path(__file__).resolve().parent
    cookies_path = script_dir / "cookies/instagram_netscape_cookies.txt"
    if not cookies_path.exists():
        raise FileNotFoundError(f"未找到 cookie 文件: {cookies_path}")

    cookies = load_playwright_cookies_from_netscape()
    if not cookies:
        raise RuntimeError("cookies 为空，无法访问 Instagram。")
    file_writer = ExploreReelsFileWriter(temp_dir="temp")

    with sync_playwright() as p:
        # 保持非 headless，便于观察登录态与页面变化（必要时可改为 True）。
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        context.add_cookies(cookies)
        page = context.new_page()
        apply_playwright_stealth(context, page)

        try:
            url_list = collect_explore_reels_urls(page, file_writer)
            print(f"共匹配到 {len(url_list)} 个 Reels URL")

            for url in url_list:
                print(url)
                downloaded_paths = download_instagram_video(url, output_path=str(file_writer.temp_dir))
                if downloaded_paths:
                    for video_path in downloaded_paths:
                        print(f"下载的视频路径: {video_path}")
                else:
                    print("下载失败或未解析出视频路径，已跳过当前 URL。")

            print("全部完成，成功")
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
