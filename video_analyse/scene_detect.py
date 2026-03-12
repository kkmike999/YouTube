"""
压缩域场景切换检测 + 截图保存
原理：
  1. 用 PyAV 遍历视频 packet，不完整解码，只读包大小
  2. 包大小突然变大 → 场景切换候选帧
  3. 对候选帧进行完整解码，截图保存
"""

import av
import cv2
import os
import sys
import numpy as np

# ── 配置 ──────────────────────────────────────────────────────────────────────
OUTPUT_DIR = r"d:\YouTube\video_analyse\temp\Capture"

# 包大小突增倍数阈值（越低越灵敏，越高越严格）
SIZE_RATIO_THRESHOLD = 9.0

# 相邻两次场景切换的最小间隔（秒），防止同一场景重复截图
MIN_INTERVAL_SEC = 1.0
# ─────────────────────────────────────────────────────────────────────────────


def collect_candidate_pts(video_path: str, ratio: float) -> list[dict]:
    """第一遍：只读 packet 大小，找候选 pts（不解码像素）"""
    container = av.open(video_path)
    stream = container.streams.video[0]

    candidates = []
    sizes = []                              # 滑动窗口：记录历史包大小，用于计算基准
    last_candidate_time = -MIN_INTERVAL_SEC

    # demux 只拆包，不解码：拿到的是压缩数据，读取代价极小
    for packet in container.demux(stream):
        if packet.size == 0:               # flush packet，跳过
            continue

        # 判断帧类型
        # is_keyframe 是编码器写入的硬标记，只有 I 帧为 True
        if packet.is_keyframe:
            ftype = "I"
        elif sizes:
            # P/B 无法从 packet 直接读取，用包大小启发式区分：
            # P 帧只参考前面的帧，包通常比 B 帧大
            median = np.median(sizes[-20:]) if len(sizes) >= 20 else np.median(sizes)
            ftype = "P" if packet.size > median * 0.5 else "B"
        else:
            ftype = "P"

        sizes.append(packet.size)

        if len(sizes) < 5:                 # 前5帧数据不足，无法计算基准
            continue

        # 基准 = 前5帧的平均包大小（不含当前帧，取 [-6:-1]）
        # 场景切换后的帧比周围帧大很多倍，正常运动只有1-2倍
        baseline = float(np.mean(sizes[-6:-1]))
        current_time = float(packet.pts * stream.time_base) if packet.pts else 0.0

        if (packet.size > baseline * ratio                              # 突增倍数超过阈值
                and current_time - last_candidate_time >= MIN_INTERVAL_SEC):  # 距上次够远
            candidates.append({
                "pts":      packet.pts,       # 用于第二遍精确定位
                "time":     current_time,
                "ftype":    ftype,
                "size":     packet.size,
                "baseline": baseline,
                "ratio":    packet.size / baseline,
            })
            last_candidate_time = current_time

    container.close()
    print(f"  找到 {len(candidates)} 个候选帧")
    return candidates


def decode_frame_by_seek(video_path: str, target_time: float) -> tuple:
    """seek 到目标时间附近的关键帧，向后解码直到找到目标时间的帧"""
    container = av.open(video_path)
    stream = container.streams.video[0]
    time_base = float(stream.time_base)
    try:
        target_us = int(target_time * 1_000_000)  # 转换为微秒（PyAV seek 单位）

        # any_frame=False：只 seek 到关键帧（I 帧）
        # 这样即使目标是 P/B 帧，也会先定位到它前面最近的 I 帧，
        # 再向后顺序解码，保证解码器有完整上下文
        container.seek(target_us, any_frame=False)

        for packet in container.demux(stream):
            if packet.size == 0:
                continue
            for frame in packet.decode():          # 完整解码，得到原始像素
                if frame.pts is None:
                    continue
                frame_time = frame.pts * time_base
                # 找到第一个到达目标时间的帧就返回，不继续解码
                if frame_time >= target_time - 0.5:
                    return frame.to_ndarray(format="bgr24"), frame_time
    except Exception:
        pass
    finally:
        container.close()                          # 确保容器一定被关闭
    return None, None


def save_frame_at_pts(video_path: str, candidates: list[dict], output_dir: str):
    """第二遍截图：对每个候选帧 seek 解码并保存图片"""
    saved = 0
    for c in candidates:
        img, actual_time = decode_frame_by_seek(video_path, c["time"])
        if img is not None:
            # 文件名带时间戳，方便对应回视频位置
            filename = os.path.join(output_dir, f"scene_{actual_time:.2f}s.jpg")
            cv2.imwrite(filename, img)
            print(f"  [{c['ftype']}帧 {c['ratio']:.1f}x]  {os.path.basename(filename)}")
            saved += 1
        else:
            print(f"  [跳过] {c['time']:.2f}s 解码失败")
    return saved


def main():
    global MIN_INTERVAL_SEC

    import argparse
    parser = argparse.ArgumentParser(description="压缩域场景切换检测")
    parser.add_argument("--path",      type=str,   default=None, help="视频文件路径")
    parser.add_argument("--threshold", type=float, default=SIZE_RATIO_THRESHOLD, help=f"包大小突增倍数阈值，默认 {SIZE_RATIO_THRESHOLD}")
    parser.add_argument("--interval",  type=float, default=MIN_INTERVAL_SEC,     help=f"相邻截图最小间隔秒数，默认 {MIN_INTERVAL_SEC}")
    args = parser.parse_args()

    video_path = args.path if args.path else ""
    MIN_INTERVAL_SEC = args.interval

    if not os.path.exists(video_path):
        print(f"视频文件不存在：{video_path}")
        sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"视频：{video_path}")
    print(f"阈值：{args.threshold}x  最小间隔：{args.interval}s")
    print("第一遍：压缩域粗筛...")
    candidates = collect_candidate_pts(video_path, args.threshold)

    if not candidates:
        print("未检测到场景切换，尝试降低 SIZE_RATIO_THRESHOLD 阈值后重试")
        return

    print("\n第二遍：解码截图...")
    saved = save_frame_at_pts(video_path, candidates, OUTPUT_DIR)

    print(f"\n完成！共保存 {saved} 张截图到：{OUTPUT_DIR}")


if __name__ == "__main__":
    main()
