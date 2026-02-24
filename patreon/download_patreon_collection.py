import os
import sys
from DrissionPage import ChromiumPage
import yt_dlp

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
    if len(sys.argv) > 1:
        collection_url = sys.argv[1]
    else:
        collection_url = input("请输入 Patreon 合集链接 (例如: https://www.patreon.com/collection/1279499?view=expanded): ").strip()

    if not collection_url or "patreon.com" not in collection_url:
        print("未输入有效链接，程序退出。")
        return

    base_download_dir = os.path.join(os.getcwd(), "download")
    
    print("正在启动浏览器并打开合集页面...")
    page = ChromiumPage()
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
    
    video_links = []
    if container:
        a_tags = container.eles('tag:a')
        for a in a_tags:
            href = a.attr('href')
            if href and '/posts/' in href:
                if href not in video_links:
                    video_links.append(href)
    else:
        print("未找到包含视频链接的容器区域！")
        
    print(f"共提取到 {len(video_links)} 个视频详情链接。\n")
    if not video_links:
        page.quit()
        return
        
    page.quit() # 获取完链接就可以关闭浏览器了
    
    # 4. 获取每个视频详情页视频信息及下载链接
    videos_data = []
    print("开始获取视频详细信息 (这可能需要一些时间)...")
    for idx, link in enumerate(video_links, 1):
        print(f"[{idx}/{len(video_links)}] 正在解析: {link}")
        info = get_video_info(link)
        if info:
            videos_data.append(info)
            
    # 5. 把上面获取的所有信息，整理成Markdown表格 并打印出来保存到文件
    if videos_data:
        markdown_str = f"### {collection_name} 视频信息列表\n\n"
        markdown_str += "| 视频标题 | 清晰度 | 总码率 | 视频详情链接 | 视频下载链接 |\n"
        markdown_str += "|---|---|---|---|---|\n"
        for info in videos_data:
            markdown_str += f"| {info['视频标题']} | {info['清晰度']} | {info['总码率']} | {info['视频详情链接']} | {info['视频下载的链接']} |\n"
            
        print("\n\n" + markdown_str)
        
        md_file_path = os.path.join(collection_dir, f"{collection_name}.md")
        try:
            with open(md_file_path, "w", encoding="utf-8") as f:
                f.write(markdown_str)
            print(f"数据已保存至: {md_file_path}\n")
        except Exception as e:
            print(f"保存 Markdown 文件失败: {e}\n")
    else:
        print("未能获取到任何视频的详细信息，无法生成表格。")
        return
        
    # 6. 让用户确认是否下载所有文件到合集目录，点击回车后，下载
    choice = input(f"是否将以上所有文件下载到合集目录 [{collection_dir}] ? (按回车键开始下载，输入 'n' 等任意其他键取消): ")
    if choice.strip() != '':
        print("已取消下载。")
        return
        
    print("\n开始批量下载...")
    download_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        'outtmpl': os.path.join(collection_dir, '%(title)s.%(ext)s'),
        'merge_output_format': 'mp4',
    }
    
    if os.path.exists("cookies.txt"):
        download_opts['cookiefile'] = 'cookies.txt'
    else:
        download_opts['cookiesfrombrowser'] = ('chrome',)
        
    with yt_dlp.YoutubeDL(download_opts) as ydl:
        for info in videos_data:
            url = info['视频详情链接']
            print(f"\n正在下载: {info['视频标题']}...")
            try:
                ydl.download([url])
            except Exception as e:
                print(f"下载失败: {e}")
                
    print(f"\n全部下载完成！文件保存在: {collection_dir}")

if __name__ == "__main__":
    main()
