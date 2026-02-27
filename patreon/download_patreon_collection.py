import os
import sys
import random
import string
import requests
from DrissionPage import ChromiumPage, ChromiumOptions
import yt_dlp
from yt_dlp.utils import sanitize_filename

def download_one(args):
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

def get_video_info(video_url):
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
        if arg.startswith("--auto-download="):
            if arg.split("=")[1].lower() == "true":
                auto_download = True
        elif arg == "--cover-only":
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
    co = ChromiumOptions().headless()
    page = ChromiumPage(addr_or_opts=co)
    page.get(collection_url)
    
    print("等待页面加载...")
    # 1. 找到'<div elementtiming="Collection : Cover" data-is-key-element="true">Moe</div>'
    name_ele = page.ele('@elementtiming=Collection : Cover', timeout=15)
    if not name_ele:
        print("未找到合集名称，网络较慢或页面结构发生变化。将使用默认名称。")
        collection_name = "Unknown_Collection"
    else:
        collection_name = name_ele.text.strip()
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
    videos_data = []
    print(f"\n开始逐个获取信息并下载 (共 {len(video_links)} 个视频)...")
    for idx, item in enumerate(video_links, 1):
        link = item['url']
        print(f"\n--------------------------------------------------")
        
        # 打开详情页获取封面
        cover_url = ""
        try:
            print(f"[{idx}/{len(video_links)}] 正在获取详情页封面: {link}")
            page.get(link)
            # 给页面足够的时间去渲染
            # page.wait.ele_displayed('tag:img', timeout=10)
            
            # 首先尝试查找指定的封面容器 kpWLcK
            cover_div = page.ele('.kpWLcK', timeout=2)
            if cover_div:
                img_ele = cover_div.ele('tag:img', timeout=1)
                if img_ele:
                    cover_url = img_ele.attr('src')
            
            # 如果没找到，尝试通过 patreon-media/p/post 的图片特征寻找
            if not cover_url:
                imgs = page.eles('tag:img')
                for img in imgs:
                    src = img.attr('src')
                    if src and '/patreon-media/p/post/' in src:
                        cover_url = src
                        break
        except Exception as e:
            print(f"获取详情页封面失败: {e}")
            
        item['cover'] = cover_url
        
        # 下载封面图片
        local_cover_path = ""
        cover_filename = ""
        if cover_url:
            try:
                print(f"[{idx}/{len(video_links)}] 正在下载封面...")
                cover_ext = cover_url.split('?')[0].split('.')[-1]
                if len(cover_ext) > 4 or not cover_ext: 
                    cover_ext = "jpg"
                
                # 如果是 cover_only 模式，我们直接拿链接的最后一段作名字，或者用 idx
                if cover_only:
                    cover_filename = f"cover_{idx}.{cover_ext}"
                else:
                    cover_filename = f"temp_cover_{idx}.{cover_ext}"
                    
                local_cover_path = os.path.join(collection_dir, cover_filename)
                r = requests.get(cover_url, timeout=10)
                if r.status_code == 200:
                    with open(local_cover_path, 'wb') as f:
                        f.write(r.content)
            except Exception as e:
                print(f"[{idx}/{len(video_links)}] 下载封面失败: {e}")
                local_cover_path = ""
                
        if cover_only:
            # 仅下载封面模式
            cover_md = f"<img src='{cover_url}' width='200'>" if cover_url else "无封面"
            row_str = f"| (未解析) | {cover_md} | - | - | {link} | - |\n"
            try:
                with open(md_file_path, "a", encoding="utf-8") as f:
                    f.write(row_str)
            except Exception as e:
                pass # 忽略追加错误
            continue
            
        print(f"[{idx}/{len(video_links)}] 正在解析视频详情: {link}")
        info = get_video_info(link)
        if info:
            info['封面链接'] = cover_url
            videos_data.append(info)
            
            # 拿到视频标题后，将临时封面文件重命名为正式的文件名
            if local_cover_path and os.path.exists(local_cover_path):
                cover_filename = f"{sanitize_filename(info['视频标题'])}_cover.{cover_ext}"
                final_cover_path = os.path.join(collection_dir, cover_filename)
                try:
                    if os.path.exists(final_cover_path):
                        os.remove(final_cover_path)
                    os.rename(local_cover_path, final_cover_path)
                    local_cover_path = final_cover_path
                except Exception as e:
                    print(f"重命名封面文件失败: {e}")
            
            # 增量追加到 Markdown 文件
            cover_md = f"<img src='{cover_url}' width='200'>" if cover_url else "无封面"
            row_str = f"| {info['视频标题']} | {cover_md} | {info['清晰度']} | {info['总码率']} | {info['视频详情链接']} | {info['视频下载的链接']} |\n"
            try:
                with open(md_file_path, "a", encoding="utf-8") as f:
                    f.write(row_str)
            except Exception as e:
                pass # 忽略追加错误
            
            print(f"[{idx}/{len(video_links)}] 正在下载视频: {info['视频标题']}...")
            download_one((info, collection_dir))
        else:
            print(f"[{idx}/{len(video_links)}] 解析详情失败，跳过下载。")
            # 如果解析失败，把临时封面文件删掉
            if local_cover_path and os.path.exists(local_cover_path):
                try:
                    os.remove(local_cover_path)
                except:
                    pass
                    
    page.quit() # 所有任务完成后关闭浏览器
            
    print(f"\n全部处理完成！合集信息已保存在: {md_file_path}")
    print(f"视频文件保存在: {collection_dir}")

if __name__ == "__main__":
    main()
    #print("Hello World")
