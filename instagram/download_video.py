from pathlib import Path

import yt_dlp


def _collect_downloaded_paths(info_dict):
    """从 yt-dlp 返回信息中提取下载结果路径，不做兜底。"""
    if not isinstance(info_dict, dict):
        raise RuntimeError("yt-dlp 返回结果不是 dict。")

    entries = info_dict.get("entries")
    items = entries if isinstance(entries, list) else [info_dict]

    paths = []
    for item in items:
        if not isinstance(item, dict):
            raise RuntimeError("yt-dlp entry 结构无效。")

        requested_downloads = item.get("requested_downloads")
        if not isinstance(requested_downloads, list) or not requested_downloads:
            raise RuntimeError("yt-dlp 未返回 requested_downloads。")

        for download_item in requested_downloads:
            if not isinstance(download_item, dict):
                raise RuntimeError("yt-dlp requested_downloads 结构无效。")
            filepath = download_item.get("filepath")
            if not filepath:
                raise RuntimeError("yt-dlp 未返回下载文件路径 filepath。")
            paths.append(str(filepath))

    # 去重并保留顺序。
    return list(dict.fromkeys(paths))


def download_instagram_video(url, output_path="./temp"):
    """下载单条 Instagram 视频并返回下载后的文件路径列表。"""
    output_dir = Path(output_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    script_dir = Path(__file__).resolve().parent

    ydl_opts = {
        "outtmpl": str(output_dir / "%(title)s.%(ext)s"),
        "format": "bestvideo+bestaudio/best",
        "merge_output_format": "mp4",
        "noplaylist": True,
    }

    cookiefile = script_dir / "cookies/instagram_netscape_cookies.txt"

    if cookiefile.exists():
        ydl_opts["cookiefile"] = str(cookiefile)
        print(f"使用 cookies: {cookiefile}")
    else:
        print(f"未找到 cookies 文件: {cookiefile}，Instagram 可能要求登录导致下载失败。")

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info_dict = ydl.extract_info(url, download=True)
        return _collect_downloaded_paths(info_dict)


if __name__ == "__main__":
    video_url = input("请输入 Instagram 视频 URL: ").strip()
    if not video_url:
        print("未输入 URL，程序已退出。")
    else:
        downloaded_paths = download_instagram_video(video_url)
        for path in downloaded_paths:
            print(f"下载完成: {path}")
