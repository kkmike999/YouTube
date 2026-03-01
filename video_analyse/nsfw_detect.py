"""
涉黄检测脚本
对 Capture 目录下所有截图逐一分析，输出风险等级和详情
"""

import os
import sys
from pathlib import Path

# ── 配置 ──────────────────────────────────────────────────────────────────────
INPUT_DIR = r"d:\YouTube\video_analyse\temp\Capture"

# 风险标签（NudeNet 检测类别）及对应中文名
RISKY_LABELS = {
    "FEMALE_GENITALIA_EXPOSED": "女性生殖器裸露",
    "MALE_GENITALIA_EXPOSED":   "男性生殖器裸露",
    "FEMALE_BREAST_EXPOSED":    "女性胸部裸露",
    "BUTTOCKS_EXPOSED":         "臀部裸露",
    "ANUS_EXPOSED":             "肛门裸露",
}

MEDIUM_LABELS = {
    "FEMALE_BREAST_COVERED":    "女性胸部遮挡",
    "FEMALE_GENITALIA_COVERED": "女性生殖器遮挡",
    "MALE_GENITALIA_COVERED":   "男性生殖器遮挡",
    "BUTTOCKS_COVERED":         "臀部遮挡",
    "BELLY_EXPOSED":            "腹部裸露",
    "ARMPITS_EXPOSED":          "腋下裸露",
}

# 判定为高风险的置信度阈值
HIGH_RISK_THRESHOLD = 0.5
MEDIUM_RISK_THRESHOLD = 0.4
# ─────────────────────────────────────────────────────────────────────────────


def classify_result(detections: list) -> tuple[str, list]:
    """
    返回 (风险等级, 触发的检测项)
    风险等级: HIGH / MEDIUM / SAFE
    """
    high_hits = []
    medium_hits = []

    for det in detections:
        label = det.get("class", "")
        score = det.get("score", 0)

        if label in RISKY_LABELS and score >= HIGH_RISK_THRESHOLD:
            high_hits.append(f"{RISKY_LABELS[label]}({score:.2f})")
        elif label in MEDIUM_LABELS and score >= MEDIUM_RISK_THRESHOLD:
            medium_hits.append(f"{MEDIUM_LABELS[label]}({score:.2f})")

    if high_hits:
        return "HIGH", high_hits
    if medium_hits:
        return "MEDIUM", medium_hits
    return "SAFE", []


def main():
    try:
        from nudenet import NudeDetector
    except ImportError:
        print("未安装 nudenet，请先运行：pip install nudenet")
        sys.exit(1)

    input_dir = Path(INPUT_DIR)
    if not input_dir.exists():
        print(f"目录不存在：{INPUT_DIR}")
        sys.exit(1)

    images = sorted(
        p for p in input_dir.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    )

    if not images:
        print("目录中没有找到图片文件")
        sys.exit(1)

    print(f"共找到 {len(images)} 张图片，开始检测...\n")
    print(f"{'文件名':<40} {'风险等级':<8} 触发项")
    print("-" * 90)

    detector = NudeDetector()

    stats = {"HIGH": 0, "MEDIUM": 0, "SAFE": 0}
    high_risk_files = []

    for i, img_path in enumerate(images, 1):
        try:
            detections = detector.detect(str(img_path))
            level, hits = classify_result(detections)
            stats[level] += 1

            if level == "SAFE":
                continue

            hit_str = ", ".join(hits)
            level_display = {"HIGH": "⚠ 高风险", "MEDIUM": "△ 中风险"}.get(level, level)
            print(f"{img_path.name:<40} {level_display:<10} {hit_str}")

            if level == "HIGH":
                high_risk_files.append(img_path.name)

        except Exception as e:
            print(f"{img_path.name:<40} [错误] {e}")

        if i % 10 == 0:
            print(f"  ... 已处理 {i}/{len(images)}")

    print("\n" + "=" * 90)
    print(f"检测完成！共 {len(images)} 张")
    print(f"  高风险 (HIGH)  : {stats['HIGH']} 张")
    print(f"  中风险 (MEDIUM): {stats['MEDIUM']} 张")
    print(f"  安全   (SAFE)  : {stats['SAFE']} 张")

    if high_risk_files:
        print(f"\n高风险文件列表：")
        for f in high_risk_files:
            print(f"  - {f}")


if __name__ == "__main__":
    main()
