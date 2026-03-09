import yt_dlp
import sys
import os

def download_video(video_url):
    download_dir = "download"
    if not os.path.exists(download_dir):
        os.makedirs(download_dir)

    # 修改 format 为 bestvideo+bestaudio/best 以下载最高画质和音质
    # 如果系统没有安装 ffmpeg，bestvideo+bestaudio 会失败并回退到 best (最高画质但可能只有720p带音频的单文件)
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        'outtmpl': f'{download_dir}/%(title)s.%(ext)s',
        'merge_output_format': 'mp4', # 尝试合并为mp4格式
    }
    
    print(f"正在获取视频信息: {video_url} ...")
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # 先仅获取信息，不下载
            info = ydl.extract_info(video_url, download=False)
            
            title = info.get('title', '未知标题')
            duration = info.get('duration')
            
            # 提取信息格式
            formats = info.get('requested_formats')
            if formats:
                v_format = formats[0]
                a_format = formats[1] if len(formats) > 1 else formats[0]
            else:
                v_format = info
                a_format = info
                
            # 文件大小预估
            filesize_bytes = 0
            if formats:
                for f in formats:
                    filesize_bytes += f.get('filesize', 0) or f.get('filesize_approx', 0) or 0
            else:
                filesize_bytes = info.get('filesize', 0) or info.get('filesize_approx', 0) or 0
                
            # 转换为合适的单位 (MB/GB)
            if filesize_bytes > 0:
                filesize_mb = filesize_bytes / (1024 * 1024)
                if filesize_mb > 1024:
                    filesize_str = f"{filesize_mb / 1024:.2f} GB"
                else:
                    filesize_str = f"{filesize_mb:.2f} MB"
            else:
                filesize_str = "未知"
                
            # 视频信息字段提取
            vcodec = v_format.get('vcodec', '未知')
            height = v_format.get('height')
            width = v_format.get('width')
            if width and height:
                resolution = f"{width}x{height}"
            elif height:
                resolution = f"{height}p"
            else:
                resolution = "未知"
                
            vbr = v_format.get('vbr', '未知')
            fps = v_format.get('fps', '未知')
            
            # 音频信息字段提取
            acodec = a_format.get('acodec', '未知')
            abr = a_format.get('abr', '未知')
            asr = a_format.get('asr', '未知')
            
            # 使用格式化字符串输出时长
            if duration:
                m, s = divmod(duration, 60)
                h, m = divmod(m, 60)
                duration_str = f"{int(h):02d}:{int(m):02d}:{int(s):02d}" if h > 0 else f"{int(m):02d}:{int(s):02d}"
            else:
                duration_str = "未知"
            
            print("\n" + "="*40)
            print(f"视频标题: {title}")
            print(f"原视频时长: {duration_str} ({duration} 秒)" if duration else "原视频时长: 未知")
            print(f"预估文件大小: {filesize_str}")
            print("-" * 40)
            print("[视频参数]")
            print(f"视频编码: {vcodec}")
            print(f"清晰度: {resolution}")
            print(f"视频码率: {vbr} kbps" if vbr != '未知' and vbr is not None else "视频码率: 未知")
            print(f"视频帧率: {fps} fps" if fps != '未知' and fps is not None else "视频帧率: 未知")
            print("-" * 40)
            print("[音频参数]")
            print(f"音频编码: {acodec}")
            print(f"音频码率: {abr} kbps" if abr != '未知' and abr is not None else "音频码率: 未知")
            print(f"采样率: {asr} Hz" if asr != '未知' and asr is not None else "采样率: 未知")
            print("=" * 40 + "\n")
            
            # 等待用户确认
            input("请按回车键开始下载 (按 Ctrl+C 取消)...")
            
            print("\n开始下载...")
            ydl.download([video_url])
            print(f"\n下载完成！文件已保存到 {download_dir} 目录中。")
            
    except KeyboardInterrupt:
        print("\n\n已取消下载。")
    except Exception as e:
        print(f"\n错误: {e}")

if __name__ == "__main__":
    # 如果通过命令行参数提供了URL，则使用该参数，否则提示用户输入
    if len(sys.argv) > 1:
        url = sys.argv[1]
    else:
        url = input("请输入YouTube视频链接: ").strip()
        
    if url:
        download_video(url)
    else:
        print("未输入有效链接，程序退出。")
