import subprocess
import json
import sys
import os

def get_video_info(file_path):
    """
    使用 ffprobe 获取 MP4 视频的详细信息
    需要系统中已安装 ffmpeg 并将其添加到了环境变量
    """
    if not os.path.exists(file_path):
        print(f"错误: 找不到文件 '{file_path}'")
        return

    try:
        # 运行 ffprobe 命令返回 JSON 格式信息
        cmd = [
            'ffprobe',
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            file_path
        ]
        
        # 执行命令
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        info = json.loads(result.stdout)
        
        video_info = {}
        audio_info = {}
        
        # 提取流信息（视频流和音频流）
        for stream in info.get('streams', []):
            if stream.get('codec_type') == 'video':
                video_info['codec'] = stream.get('codec_name')
                video_info['profile'] = stream.get('profile')
                video_info['width'] = stream.get('width')
                video_info['height'] = stream.get('height')
                # 清晰度/分辨率
                if video_info['width'] and video_info['height']:
                    video_info['resolution'] = f"{video_info['width']}x{video_info['height']}"
                video_info['bit_rate'] = stream.get('bit_rate')
                video_info['frame_rate'] = stream.get('r_frame_rate')
                
            elif stream.get('codec_type') == 'audio':
                audio_info['codec'] = stream.get('codec_name')
                audio_info['sample_rate'] = stream.get('sample_rate')
                audio_info['channels'] = stream.get('channels')
                audio_info['bit_rate'] = stream.get('bit_rate')
        
        # 提取总体格式信息
        format_info = info.get('format', {})
        duration = format_info.get('duration')
        size = format_info.get('size')
        overall_bitrate = format_info.get('bit_rate')
        
        # 打印输出结果
        print("="*40)
        print(f"视频文件: {os.path.basename(file_path)}")
        print("="*40)
        
        if size:
            print(f"文件大小: {int(size) / (1024*1024):.2f} MB")
        if duration:
            print(f"视频时长: {float(duration):.2f} 秒")
        if overall_bitrate:
            print(f"总 码 率: {int(overall_bitrate) / 1000:.0f} kbps")
            
        print("\n[视频信息]")
        if video_info:
            print(f"视频编码: {video_info.get('codec')} ({video_info.get('profile')})")
            print(f"清 晰 度: {video_info.get('resolution')}")
            if video_info.get('bit_rate'):
                print(f"视频码率: {int(video_info.get('bit_rate')) / 1000:.0f} kbps")
            
            # 帧率计算
            fps_str = video_info.get('frame_rate', '0/0')
            if '/' in fps_str:
                num, den = fps_str.split('/')
                if den != '0':
                    print(f"视频帧率: {int(num)/int(den):.2f} fps")
        else:
            print("未找到视频流信息")
                
        print("\n[音频信息]")
        if audio_info:
            print(f"音频编码: {audio_info.get('codec')}")
            if audio_info.get('bit_rate'):
                print(f"音频码率: {int(audio_info.get('bit_rate')) / 1000:.0f} kbps")
            else:
                print("音频码率: (可能是动态码率, 未知)")
            print(f"采 样 率: {audio_info.get('sample_rate')} Hz")
            print(f"声 道 数: {audio_info.get('channels')}")
        else:
            print("未找到音频流信息")
        print("="*40)
            
    except json.JSONDecodeError:
         print("错误: 无法解析 ffprobe 的输出信息，可能文件不是有效的多媒体文件。")
    except FileNotFoundError:
        print("错误: 找不到 ffprobe 命令。")
        print("请确保已安装 FFmpeg，并将其 bin 目录添加到了系统的环境变量(Path)中。")
    except Exception as e:
        print(f"提取视频信息时出现未知错误: {e}")

if __name__ == '__main__':
    # 允许通过命令行传递视频路径
    if len(sys.argv) > 1:
        video_path = sys.argv[1]
    else:
        # 如果没有提供参数，则提示用户输入
        video_path = input("请输入 MP4 视频的完整路径: ").strip()
        
        # 处理可能包含的引号(例如用户直接将文件拖拽进入终端)
        if video_path.startswith('"') and video_path.endswith('"'):
            video_path = video_path[1:-1]
        elif video_path.startswith("'") and video_path.endswith("'"):
            video_path = video_path[1:-1]
            
    if video_path:
        get_video_info(video_path)
    else:
        print("未输入有效的文件路径，程序退出。")
