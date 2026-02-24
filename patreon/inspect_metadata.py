# 这是一个临时脚本，测试获取patreon视频的元数据

import yt_dlp
import json

ydl_opts = {
    'cookiefile': 'cookies.txt',
    'quiet': True,
    'no_warnings': True,
}

url = "https://www.patreon.com/posts/134407294?collection=1279499"

with yt_dlp.YoutubeDL(ydl_opts) as ydl:
    info = ydl.extract_info(url, download=False)
    
    # 检查顶层可用了哪些字段 (例如时长、文件大小等)
    print("顶层字段信息:")
    for k in ['duration', 'filesize', 'filesize_approx', 'vcodec', 'acodec', 'width', 'height', 'fps', 'vbr', 'abr', 'tbr', 'format']:
        print(f"  {k}: {info.get(k)}")
        
    # 检查可选的分辨率与格式流
    formats = info.get('formats', [])
    print(f"\n找到的视频格式流数量: {len(formats)}")
    
    if formats:
        # 仅打印最高质量的格式信息，看看它包含了什么
        print("\n最高画质格式信息:")
        best_format = formats[-1]
        for k in ['format_id', 'ext', 'resolution', 'vcodec', 'acodec', 'filesize', 'filesize_approx', 'vbr', 'abr', 'tbr', 'fps']:
            print(f"  {k}: {best_format.get(k)}")
            
    # 将完整的 json 信息导出到文件，方便人工检查内部结构
    with open('dump.json', 'w', encoding='utf-8') as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    print("\n完整的元数据已保存至 dump.json 文件")
