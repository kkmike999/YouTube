import os
import sys
import time
import random
import string
import requests
from DrissionPage import ChromiumPage, ChromiumOptions
import yt_dlp
from yt_dlp.utils import sanitize_filename

def wait_if_challenged(page):
    """
    检测 Patreon/Cloudflare 实人验证页面，若检测到则暂停脚本，
    等待用户手动完成验证后按回车继续。

    触发条件（满足任一）：
      - 页面标题含 "Just a moment" / "Security Check" / "Verify you are human"
      - 当前 URL 含 "/challenge" 或 "cloudflare"
    """
    challenge_titles = ("just a moment", "security check", "verify you are human", "attention required")
    title = page.title.lower()
    url = page.url.lower()
    if any(k in title for k in challenge_titles) or "/challenge" in url or "cloudflare" in url:
        print("\n[!] 检测到实人验证页面，请在浏览器中手动完成验证。")
        input("    完成后按回车键继续...")


# 下载单个视频
def download_one(args):
    """
    下载单个视频到指定目录。

    参数：
      args: (info, collection_dir) 元组
        - info          : get_video_info() 返回的字典，需包含 '视频详情链接' 和 '视频标题'
        - collection_dir: 视频保存目录

    若目标文件已存在，则在文件名末尾追加随机后缀（字母+数字）避免覆盖。
    Cookie 优先读取 cookies.txt，否则从本地 Chrome 浏览器读取。
    """
    info, collection_dir = args
    url = info['视频详情链接']
    title = info['视频标题']
    
    expected_file = os.path.join(collection_dir, f"{sanitize_filename(title)}.mp4")
    
    if os.path.exists(expected_file):
        rand_str = random.choice(string.ascii_letters) + str(random.randint(0, 9))
        outtmpl = os.path.join(collection_dir, f"%(title)s_{rand_str}.%(ext)s")
        print(f"\n[提示] 文件已存在，即将添加随机后缀: _{rand_str}")
    else:
        outtmpl = os.path.join(collection_dir, '%(title)s.%(ext)s')

    opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        'outtmpl': outtmpl,
        'merge_output_format': 'mp4',
    }
    if os.path.exists('cookies.txt'):
        opts['cookiefile'] = 'cookies.txt'
    else:
        opts['cookiesfrombrowser'] = ('chrome',)
        
    print(f'\n[开始] {title}')
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        print(f'[完成] {title}')
    except Exception as e:
        print(f'[失败] {title}: {e}')

# 获取详情页封面
def fetch_and_save_cover(page, link, collection_dir, idx):
    """
    导航到帖子详情页，提取封面图片 URL 并下载保存。

    封面查找策略（依次尝试）：
      1. XPath 定位 class 含 "dkLWJN" 的封面容器，取其子 <img> 的 src
         （DrissionPage CSS 选择器不支持含数字的类名 sc-891badcd-1，改用 XPath）
      2. 遍历页面所有 <img>，取第一个 URL 含 /patreon-media/p/post/ 的图片

    封面文件名为 "{帖子标题}.{ext}"，标题从浏览器页面标题获取（去掉末尾 " | Patreon"）。
    若标题获取失败则以 "cover_{idx}.{ext}" 兜底命名。

    参数：
      page          : DrissionPage ChromiumPage 实例
      link          : 帖子详情页 URL（如 https://www.patreon.com/posts/xxxxxx）
      collection_dir: 封面图片保存目录
      idx           : 当前视频序号，仅用于标题获取失败时的兜底文件名

    返回 (cover_url, post_title, local_cover_path)：
      - cover_url       : 封面原始 URL，未找到时为空字符串
      - post_title      : 帖子标题，获取失败时为空字符串
      - local_cover_path: 封面本地保存路径，下载失败时为空字符串
    """
    cover_url = ""
    post_title = ""
    local_cover_path = ""

    try:
        # 随机延迟 2~6 秒，模拟人工浏览节奏，降低被风控的概率
        time.sleep(random.uniform(2, 6))
        page.get(link)
        wait_if_challenged(page)

        post_title = page.title.removesuffix(" | Patreon").strip()

        # 首先通过 xpath 定位封面容器 (class=dkLWJN)，再取其子 img
        # 注意：DrissionPage CSS 选择器不支持含数字的类名如 sc-891badcd-1，需改用 xpath
        cover_div = page.ele('x://div[contains(@class,"dkLWJN")]', timeout=3)
        if cover_div:
            img_ele = cover_div.ele('tag:img', timeout=2)
            if img_ele:
                cover_url = img_ele.attr('src')

        # 兜底：遍历所有 img，取第一个 patreon-media/p/post 路径的图片
        if not cover_url:
            for img in page.eles('tag:img'):
                src = img.attr('src')
                if src and '/patreon-media/p/post/' in src:
                    cover_url = src
                    break
    except Exception as e:
        print(f"获取详情页封面失败: {e}")

    if cover_url:
        try:
            cover_ext = cover_url.split('?')[0].split('.')[-1]
            if len(cover_ext) > 4 or not cover_ext:
                cover_ext = "jpg"

            cover_name = sanitize_filename(post_title) if post_title else f"cover_{idx}"
            local_cover_path = os.path.join(collection_dir, f"{cover_name}.{cover_ext}")

            r = requests.get(cover_url, timeout=10)
            if r.status_code == 200:
                with open(local_cover_path, 'wb') as f:
                    f.write(r.content)
            else:
                local_cover_path = ""
        except Exception as e:
            print(f"下载封面失败: {e}")
            local_cover_path = ""

    return cover_url, post_title, local_cover_path

# 获取视频详情（yt-dlp解析视频元数据）
def process_all_videos(page, video_links, collection_dir, cover_only, md_file_path):
    """
    遍历所有视频链接，逐一获取封面、解析元数据并下载视频，同时增量写入 Markdown 记录。

    每条视频的处理流程：
      1. 调用 fetch_and_save_cover() 打开详情页、下载封面
      2. cover_only 模式：仅写入 Markdown 行后跳过，不下载视频
      3. 普通模式：调用 get_video_info() 解析元数据 → 写入 Markdown → 调用 download_one() 下载视频
         若元数据解析失败，则删除已下载的封面文件

    参数：
      page          : DrissionPage ChromiumPage 实例（浏览器已打开）
      video_links   : 视频链接列表，每项为 {'url': str, 'cover': str}
      collection_dir: 视频与封面的保存目录
      cover_only    : 为 True 时仅下载封面，跳过视频下载
      md_file_path  : 增量追加视频信息行的 Markdown 文件路径

    返回：
      videos_data: 成功解析的视频信息字典列表（cover_only 模式下为空列表）
    """
    videos_data = []
    print(f"\n开始逐个获取信息并下载 (共 {len(video_links)} 个视频)...")
    for idx, item in enumerate(video_links, 1):
        link = item['url']
        print(f"\n--------------------------------------------------")

        print(f"[{idx}/{len(video_links)}] 正在获取详情页封面: {link}")
        cover_url, post_title, local_cover_path = fetch_and_save_cover(page, link, collection_dir, idx)
        item['cover'] = cover_url

        if cover_only:
            cover_md = f"<img src='{cover_url}' width='200'>" if cover_url else "无封面"
            row_str = f"| (未解析) | {cover_md} | - | - | {link} | - |\n"
            try:
                with open(md_file_path, "a", encoding="utf-8") as f:
                    f.write(row_str)
            except Exception:
                pass
            continue

        print(f"[{idx}/{len(video_links)}] 正在解析视频详情: {link}")
        info = get_video_info(link)
        if info:
            info['封面链接'] = cover_url
            videos_data.append(info)

            cover_md = f"<img src='{cover_url}' width='200'>" if cover_url else "无封面"
            row_str = f"| {info['视频标题']} | {cover_md} | {info['清晰度']} | {info['总码率']} | {info['视频详情链接']} | {info['视频下载的链接']} |\n"
            try:
                with open(md_file_path, "a", encoding="utf-8") as f:
                    f.write(row_str)
            except Exception:
                pass

            print(f"[{idx}/{len(video_links)}] 正在下载视频: {info['视频标题']}...")
            download_one((info, collection_dir))
        else:
            print(f"[{idx}/{len(video_links)}] 解析详情失败，跳过下载。")
            if local_cover_path and os.path.exists(local_cover_path):
                try:
                    os.remove(local_cover_path)
                except Exception:
                    pass

    return videos_data


def get_video_info(video_url):
    """
    使用 yt-dlp 从 Patreon 帖子详情页解析视频元数据，不触发实际下载。

    参数：
      video_url: 帖子详情页 URL（如 https://www.patreon.com/posts/xxxxxx）

    返回包含以下字段的字典，失败时返回 None：
      - '视频标题'      : 视频标题
      - '清晰度'        : 分辨率字符串，如 "1920x1080" 或 "1080p"
      - '总码率'        : 综合码率字符串，如 "5000 kbps"
      - '视频详情链接'  : 原始帖子 URL（即传入的 video_url）
      - '视频下载的链接': yt-dlp 解析出的带鉴权 token 的 CDN 直链（有时效性）

    Cookie 优先读取 cookies.txt，否则从本地 Chrome 浏览器读取。
    """
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        'quiet': True,
        'no_warnings': True,
    }
    
    if os.path.exists("cookies.txt"):
        ydl_opts['cookiefile'] = 'cookies.txt'
    else:
        ydl_opts['cookiesfrombrowser'] = ('chrome',)
        
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
            
            title = info.get('title', '未知标题')
            
            formats = info.get('requested_formats')
            if formats:
                v_format = formats[0]
            else:
                v_format = info
                
            height = v_format.get('height')
            width = v_format.get('width')
            if width and height:
                resolution = f"{width}x{height}"
            elif height:
                resolution = f"{height}p"
            else:
                resolution = "未知"
                
            tbr = v_format.get('tbr') or info.get('tbr')
            bitrate = f"{tbr} kbps" if tbr else "未知"
            
            if formats:
                download_link = formats[0].get('url', info.get('url', '未知链接'))
            else:
                download_link = v_format.get('url', '未知链接')
                
            return {
                '视频标题': title,
                '清晰度': resolution,
                '总码率': bitrate,
                '视频详情链接': video_url,
                '视频下载的链接': download_link
            }
    except Exception as e:
        print(f"获取视频 {video_url} 信息失败: {e}")
        return None

def main():
    auto_download = False
    cover_only = False
    collection_url = ""
    for arg in sys.argv[1:]:
        if "--auto-download" in arg:
            auto_download = True
        elif "--cover-only" in arg:
            cover_only = True
            auto_download = True  # 有 --cover-only 时自动下载
        elif not arg.startswith("--") and not collection_url:
            collection_url = arg

    if not collection_url:
        collection_url = input("请输入 Patreon 合集链接 (例如: https://www.patreon.com/collection/1279499?view=expanded): ").strip()

    if not collection_url or "patreon.com" not in collection_url:
        print("未输入有效链接，程序退出。")
        return

    base_download_dir = os.path.join(os.getcwd(), "download")
    
    print("正在启动浏览器并打开合集页面...")
    co = ChromiumOptions()  # 非无头模式，避免 Patreon 检测到机器人而拒绝渲染页面
    # 屏蔽 navigator.webdriver 标志，降低被反爬识别的概率
    co.set_argument('--disable-blink-features=AutomationControlled')
    co.set_pref('excludeSwitches', ['enable-automation'])
    co.set_pref('useAutomationExtension', False)
    page = ChromiumPage(addr_or_opts=co)
    # 覆盖 JS 层的 webdriver 属性，防止页面脚本检测
    page.run_cdp('Page.addScriptToEvaluateOnNewDocument',
                 source='Object.defineProperty(navigator,"webdriver",{get:()=>undefined})')
    page.get(collection_url)
    wait_if_challenged(page)
    
    print("等待页面加载...")
    # 1. 找到'<div elementtiming="Collection : Cover" data-is-key-element="true">Moe</div>'
    name_ele = page.ele('@elementtiming=Collection : Cover', timeout=15)
    if not name_ele:
        print("未找到合集名称，网络较慢或页面结构发生变化。")
        # collection_name = "Unknown_Collection"
        return
    else:
        collection_name = name_ele.text.strip().replace(" ", "").replace("/", "_")
        print(f"找到合集名: {collection_name}")
        
    # 2. 在 @[d:\YouTube\petroen\download] 目录下，新建合集目录
    collection_dir = os.path.join(base_download_dir, collection_name)
    if not os.path.exists(collection_dir):
        os.makedirs(collection_dir)
        print(f"创建合集目录: {collection_dir}")
        
    # 3. 找到合集所有视频详情页链接
    # 找到class包含"CardLayout-module" & "CollectionPostList-module"且data-cardlayout-edgeless="true"的div
    xpath_expr = '//div[contains(@class, "CardLayout-module") and contains(@class, "CollectionPostList-module") and @data-cardlayout-edgeless="true"]'
    container = page.ele(f'x:{xpath_expr}', timeout=10)
    
    video_links = [] # 存储字典: {'url': href, 'cover': ''}
    if container:
        a_tags = container.eles('tag:a')
        for a in a_tags:
            href = a.attr('href')
            if href and '/posts/' in href:
                existing = next((v for v in video_links if v['url'] == href), None)
                if not existing:
                    video_links.append({'url': href, 'cover': ''})
    else:
        print("未找到包含视频链接的容器区域！")
        
    print(f"共提取到 {len(video_links)} 个视频详情。\n")
    if not video_links:
        page.quit()
        return
        
    # 为了获取详情页的封面，我们先不关闭 page
    # page.quit() # 获取完链接就可以关闭浏览器了
    
    # 4. 询问用户是否开始逐个获取并下载
    if not auto_download:
        choice = input(f"即将开始逐个获取并下载共 {len(video_links)} 个视频到合集目录 [{collection_dir}]。是否继续? (按回车键开始，输入 'n' 等任意其他键取消): ")
        if choice.strip() != '':
            print("已取消。")
            return
    else:
        print(f"\n[自动下载模式] 即将开始逐个获取并下载共 {len(video_links)} 个视频到合集目录 [{collection_dir}]")

    # 5. 初始化 Markdown 文件
    md_file_path = os.path.join(collection_dir, f"{collection_name}.md")
    markdown_str = f"### {collection_name} 视频信息列表\n\n"
    markdown_str += "| 视频标题 | 视频封面 | 清晰度 | 总码率 | 视频详情链接 | 视频下载链接 |\n"
    markdown_str += "|---|---|---|---|---|---|\n"
    try:
        with open(md_file_path, "w", encoding="utf-8") as f:
            f.write(markdown_str)
    except Exception as e:
        print(f"初始化 Markdown 文件失败: {e}\n")

    # 6. 逐个获取视频详情、封面图片并下载
    videos_data = process_all_videos(page, video_links, collection_dir, cover_only, md_file_path)
                    
    page.quit() # 所有任务完成后关闭浏览器
            
    print(f"\n全部处理完成！合集信息已保存在: {md_file_path}")
    print(f"视频文件保存在: {collection_dir}")

if __name__ == "__main__":
    main()
    #print("Hello World")
