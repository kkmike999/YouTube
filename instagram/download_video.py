import yt_dlp

def download_instagram_video(url, output_path='./temp/'):
    ydl_opts = {
        'outtmpl': f'{output_path}/%(title)s.%(ext)s',
        'format': 'best',
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

if __name__ == '__main__':
    video_url = input('请输入 Instagram 视频 URL: ').strip()
    if not video_url:
        print('未输入 URL，程序已退出。')
    else:
        download_instagram_video(video_url)