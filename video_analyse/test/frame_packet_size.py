"""
分析视频中每个关键帧（I帧）及其后续 P/B 帧的包大小。
使用 PyAV 流式读取，避免大文件卡住。

安装依赖:
    pip install av

用法:
    python frame_packet_size.py --path <视频文件路径>
"""

import argparse
import sys
from pathlib import Path

try:
    import av
except ImportError:
    print("错误: 请先安装 PyAV:  pip install av", file=sys.stderr)
    sys.exit(1)

_PICT_TYPE_MAP = {0: "NONE", 1: "I", 2: "P", 3: "B", 4: "S", 5: "SI", 6: "SP", 7: "BI"}


def flush_gop(gop_index: int, current_gop_header: tuple | None, pb_frames: list) -> int:
    """打印一个 GOP 的所有帧信息，返回更新后的 gop_index。"""
    if current_gop_header is None:
        return gop_index

    ki, kpts, ksize = current_gop_header
    pb_count = len(pb_frames)
    pb_total = sum(s for _, _, _, s in pb_frames)
    pb_avg = pb_total / pb_count if pb_count > 0 else 0

    def b2kb(b: int) -> str:
        return f"{b / 1024:.2f}"

    print("-" * 55)
    print(
        f"GOP #{gop_index}  I帧序号={ki}  时间={kpts:.3f}s  "
        f"I帧大小={b2kb(ksize)}KB  "
        f"P/B帧数={pb_count}  P/B总={b2kb(pb_total)}KB  P/B均={pb_avg / 1024:.2f}KB"
    )
    print(f"  {'类型':<4} {'帧序号':<10} {'时间(s)':<12} {'包大小(KB)'}")
    print(f"  [I]  {ki:<10} {kpts:<12.3f} {b2kb(ksize)}")
    for ftype, fidx, fpts, fsize in pb_frames:
        print(f"  [{ftype}]  {fidx:<10} {fpts:<12.3f} {b2kb(fsize)}")

    return gop_index + 1


def print_video_info(
    container: av.container.InputContainer,
    stream: av.video.stream.VideoStream,
) -> None:
    """输出视频整体概况。"""
    duration_s = float(container.duration) / av.time_base if container.duration else None
    duration_str = f"{int(duration_s // 3600):02d}:{int(duration_s % 3600 // 60):02d}:{duration_s % 60:06.3f}" if duration_s else "N/A"

    fps = float(stream.average_rate) if stream.average_rate else None
    fps_str = f"{round(fps)}" if fps else "N/A"

    total_frames = stream.frames or (int(duration_s * fps) if duration_s and fps else None)
    total_frames_str = str(total_frames) if total_frames else "N/A"

    width = stream.width or "N/A"
    height = stream.height or "N/A"

    codec_name = stream.codec_context.name or "N/A"
    profile = stream.codec_context.profile or "N/A"
    pix_fmt = stream.codec_context.pix_fmt or "N/A"
    bit_rate = container.bit_rate
    bit_rate_str = f"{bit_rate / 1000:.1f} kbps" if bit_rate else "N/A"

    print("=" * 55)
    print("视频概况")
    print("=" * 55)
    print(f"  文件路径  : {container.name}")
    print(f"  时长      : {duration_str}")
    print(f"  分辨率    : {width}x{height}")
    print(f"  帧率      : {fps_str} fps")
    print(f"  总帧数    : {total_frames_str}")
    print(f"  编码格式  : {codec_name}  profile={profile}")
    print(f"  像素格式  : {pix_fmt}")
    print(f"  码率      : {bit_rate_str}")
    print("=" * 55)
    print()


def analyze_and_print(video_path: str, interval: float = 1.0) -> None:
    gop_index = 0
    current_gop_header = None
    pb_frames = []

    with av.open(video_path) as container:
        stream = container.streams.video[0]
        stream.codec_context.skip_frame = "DEFAULT"

        print_video_info(container, stream)

        frame_index = 0
        next_sample_pts = 0.0

        for packet in container.demux(stream):
            if packet.size == 0:
                continue

            pict_type = None
            pts_time = float(packet.pts * stream.time_base) if packet.pts is not None else 0.0

            for frame in packet.decode():
                pt = frame.pict_type
                pict_type = pt.name if hasattr(pt, "name") else _PICT_TYPE_MAP.get(int(pt), "NONE")
                break

            if pict_type is None:
                frame_index += 1
                continue

            pkt_size = packet.size

            if pict_type == "I":
                if pts_time >= next_sample_pts:
                    gop_index = flush_gop(gop_index, current_gop_header, pb_frames)
                    current_gop_header = (frame_index, pts_time, pkt_size)
                    pb_frames = []
                    next_sample_pts = pts_time + interval
                else:
                    current_gop_header = None
                    pb_frames = []
            elif pict_type in ("P", "B") and current_gop_header is not None:
                pb_frames.append((pict_type, frame_index, pts_time, pkt_size))

            frame_index += 1

        flush_gop(gop_index, current_gop_header, pb_frames)

    print("-" * 55)


def main():
    parser = argparse.ArgumentParser(
        description="分析视频每个关键帧（I帧）及其后续 P/B 帧的包大小"
    )
    parser.add_argument("--path", required=True, help="视频文件路径")
    parser.add_argument("--interval", type=float, default=1.0, help="关键帧采样间隔（秒），默认 1")
    args = parser.parse_args()

    if args.interval <= 0:
        print("错误: --interval 必须大于 0", file=sys.stderr)
        sys.exit(1)

    video_path = args.path
    if not Path(video_path).exists():
        print(f"错误: 文件不存在: {video_path}", file=sys.stderr)
        sys.exit(1)

    print(f"分析视频: {video_path}\n")
    analyze_and_print(video_path, interval=args.interval)


if __name__ == "__main__":
    main()
