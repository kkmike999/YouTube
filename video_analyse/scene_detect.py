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
VIDEO_PATH = r"d:\YouTube\video_analyse\temp\★ASMR Full back massage to relieve work fatigue｜No talking【Director's cut】仕事後の疲れを癒す背面全体オイルマッサージ｜#EnaMassage.mp4"
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
    sizes = []
    last_candidate_time = -MIN_INTERVAL_SEC

    for packet in container.demux(stream):
        if packet.size == 0:
            continue

        if packet.is_keyframe:
            ftype = "I"
        elif sizes:
            median = np.median(sizes[-20:]) if len(sizes) >= 20 else np.median(sizes)
            ftype = "P" if packet.size > median * 0.5 else "B"
        else:
            ftype = "P"

        sizes.append(packet.size)

        if len(sizes) < 5:
            continue

        baseline = float(np.mean(sizes[-6:-1]))
        current_time = float(packet.pts * stream.time_base) if packet.pts else 0.0

        if (packet.size > baseline * ratio
                and current_time - last_candidate_time >= MIN_INTERVAL_SEC):
            candidates.append({
                "pts":      packet.pts,
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


def save_frame_at_pts(video_path: str, candidates: list[dict], output_dir: str):
    """第二遍：只对候选帧做完整解码，截图保存"""
    container = av.open(video_path)
    stream = container.streams.video[0]
    time_base = float(stream.time_base)

    pts_map = {c["pts"]: c for c in candidates}
    saved = 0

    for packet in container.demux(stream):
        if packet.pts not in pts_map:
            continue

        c = pts_map[packet.pts]
        for frame in packet.decode():
            img = frame.to_ndarray(format="bgr24")
            time_sec = frame.pts * time_base
            filename = os.path.join(output_dir, f"scene_{time_sec:.2f}s.jpg")
            cv2.imwrite(filename, img)
            print(f"  [{c['ftype']}帧 {c['ratio']:.1f}x]  {os.path.basename(filename)}")
            saved += 1

        del pts_map[packet.pts]
        if not pts_map:
            break

    container.close()
    return saved


def main():
    if not os.path.exists(VIDEO_PATH):
        print(f"视频文件不存在：{VIDEO_PATH}")
        sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("第一遍：压缩域粗筛...")
    candidates = collect_candidate_pts(VIDEO_PATH, SIZE_RATIO_THRESHOLD)

    if not candidates:
        print("未检测到场景切换，尝试降低 SIZE_RATIO_THRESHOLD 阈值后重试")
        return

    print("\n第二遍：解码截图...")
    saved = save_frame_at_pts(VIDEO_PATH, candidates, OUTPUT_DIR)

    print(f"\n完成！共保存 {saved} 张截图到：{OUTPUT_DIR}")


if __name__ == "__main__":
    main()
