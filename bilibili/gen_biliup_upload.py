#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 bilibili_发布计划表.md 读取行，过滤「已发布=Y」，按条数生成 biliup upload 的 bash 片段。
条数由 -n/--count 指定；未指定时在交互终端提示输入。
"""

from __future__ import annotations

import argparse
import re
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class PlanRow:
    index: str
    date: str
    weekday: str
    title: str
    cover_rel: str
    video_rel: str
    published: str


def split_md_row(line: str) -> list[str]:
    line = line.rstrip("\n")
    if not line.strip().startswith("|"):
        return []
    parts = [p.strip() for p in line.strip().split("|")]
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


def is_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells)


def parse_plan_table(text: str) -> list[PlanRow]:
    lines = text.splitlines()
    header_idx = None
    col_index: dict[str, int] = {}

    for i, line in enumerate(lines):
        cells = split_md_row(line)
        if len(cells) < 2:
            continue
        if "序号" in cells[0] or (len(cells) > 1 and "日期" in cells[1]):
            # 表头：序号 | 日期 | 周几 | 视频名 | 封面 | 视频 | 已发布
            if "视频相对路径" in "".join(cells):
                header_idx = i
                for j, name in enumerate(cells):
                    col_index[name.strip()] = j
                break

    if header_idx is None:
        raise ValueError("未找到 Markdown 表格表头（需含「序号」「日期」「视频相对路径」等列）")

    def col(*names: str) -> int:
        for n in names:
            if n in col_index:
                return col_index[n]
        raise KeyError(f"缺少列: {names}")

    idx_seq = col("序号")
    idx_date = col("日期")
    idx_week = col("周几")
    idx_title = col("视频名")
    idx_cover = col("视频封面相对路径")
    idx_video = col("视频相对路径")
    idx_pub = col("已发布（Y/N）")

    rows: list[PlanRow] = []
    for line in lines[header_idx + 1 :]:
        cells = split_md_row(line)
        if len(cells) < 7:
            continue
        if is_separator_row(cells):
            continue
        try:
            rows.append(
                PlanRow(
                    index=cells[idx_seq],
                    date=cells[idx_date],
                    weekday=cells[idx_week],
                    title=cells[idx_title],
                    cover_rel=cells[idx_cover],
                    video_rel=cells[idx_video],
                    published=cells[idx_pub],
                )
            )
        except IndexError:
            continue

    return rows


def norm_published_flag(s: str) -> str:
    return s.strip().upper()


def path_join_base(base: str, rel: str) -> str:
    base = base.rstrip("/\\")
    rel = rel.strip().replace("\\", "/")
    if not rel:
        return base
    return f"{base}/{rel}"


def title_for_biliup(title: str) -> str:
    """生成 --title 用：去掉 【ASMR】；反复去掉结尾的 Massage（如 …｜#RinMassage → …｜#Rin）。"""
    t = title.replace("【ASMR】", "").strip()
    suffix = "Massage"
    while True:
        t = t.rstrip()
        if not t.endswith(suffix):
            break
        t = t[: -len(suffix)].rstrip()
    return t


def render_script(
    items: list[PlanRow],
    base_dir: str,
    publish_time: str,
    source_url: str,
    tid: int,
    extra_fields: str,
    tags: str,
) -> str:
    # 与 upload_bilibili.sh 模板一致
    desc_arg = "$'留意置顶评论区！\\n留意置顶评论区！\\n留意置顶评论区！'"

    lines: list[str] = [
        "#!/usr/bin/env bash",
        "# 由 gen_biliup_upload.py 生成，请勿手改长参数；需要时重新运行脚本。",
        "set -euo pipefail",
        "",
        f"BASE_DIR={shlex.quote(base_dir)}",
        "",
    ]

    for r in items:
        video_path = path_join_base(base_dir, r.video_rel)
        dt = f'{r.date} {publish_time}'
        warn = ""
        if not r.cover_rel.strip():
            warn = "（无封面路径，已省略 --cover）"
        lines.append(f"# 序号 {r.index} | {r.date} {r.weekday}{warn}")
        lines.append("biliup upload \\")
        lines.append(f"  {shlex.quote(video_path)} \\")

        if r.cover_rel.strip():
            cover_path = path_join_base(base_dir, r.cover_rel)
            lines.append(f"  --cover {shlex.quote(cover_path)} \\")

        lines.append(f"  --title {shlex.quote(title_for_biliup(r.title))} \\")
        lines.append("  --copyright 2 \\")
        lines.append(f"  --source {shlex.quote(source_url)} \\")
        lines.append(f"  --tid {tid} \\")
        lines.append(f"  --extra-fields {shlex.quote(extra_fields)} \\")
        lines.append(f"  --tag {shlex.quote(tags)} \\")
        lines.append(f"  --desc {desc_arg} \\")
        lines.append("  --dolby 1 \\")
        lines.append("  --hires 1 \\")
        lines.append(f'  --dtime $(date -d {shlex.quote(dt)} +%s)')
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def parse_positive_int(s: str) -> int | None:
    s = s.strip()
    if not s.isdigit():
        return None
    n = int(s)
    return n if n >= 1 else None


def resolve_count(cli_value: int | None) -> int:
    """命令行未传 count 时，在交互环境下提示用户输入。"""
    if cli_value is not None:
        if cli_value < 1:
            print("错误：count 须为 >= 1 的整数", file=sys.stderr)
            raise SystemExit(2)
        return cli_value

    if not sys.stdin.isatty():
        print("错误：未指定条数。非交互环境请使用 -n / --count", file=sys.stderr)
        raise SystemExit(2)

    while True:
        raw = input("请输入要生成的 biliup 命令条数: ").strip()
        n = parse_positive_int(raw)
        if n is not None:
            return n
        print("请输入正整数（>=1），例如 3", file=sys.stderr)


def parse_iso_month_day(iso_date: str) -> tuple[int, int]:
    """表格「日期」列形如 2026-03-27，返回 (月, 日) 整数，用于文件名。"""
    s = iso_date.strip()
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if not m:
        raise ValueError(f"无法解析日期: {iso_date!r}")
    month, day = int(m.group(2)), int(m.group(3))
    if not (1 <= month <= 12 and 1 <= day <= 31):
        raise ValueError(f"日期越界: {iso_date!r}")
    return month, day


def default_output_sh_path(selected: list[PlanRow], temp_dir: Path) -> Path:
    """upload_multi_{首条月}月{首条日}日~{末条月}月{末条日}日.sh"""
    first_m, first_d = parse_iso_month_day(selected[0].date)
    last_m, last_d = parse_iso_month_day(selected[-1].date)
    name = f"upload_multi_{first_m}月{first_d}日~{last_m}月{last_d}日.sh"
    return temp_dir / name


def main() -> int:
    p = argparse.ArgumentParser(description="从发布计划 Markdown 生成 biliup upload shell")
    p.add_argument(
        "-i",
        "--input",
        type=Path,
        default=Path(__file__).resolve().parent / "md" / "bilibili_发布计划表.md",
        help="Markdown 计划表路径",
    )
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="输出的 .sh 路径；省略则写入 bilibili/temp/upload_multi_{首条月}月{首条日}日~{末条月}月{末条日}日.sh",
    )
    p.add_argument(
        "--base-dir",
        default=r"E:\TubeGet\JAPANESE ASMR MASSAGE",
        help="视频根目录（与表格中相对路径拼接）",
    )
    p.add_argument(
        "--publish-time",
        default="21:00",
        help='定时发布时间「时:分」，与表格「日期」列组合为 date -d 参数',
    )
    p.add_argument(
        "--source",
        default="https://www.youtube.com/@TOKYOASMRMASSAGE",
        help="--source",
    )
    p.add_argument("--tid", type=int, default=21, help="分区 tid")
    p.add_argument(
        "--extra-fields",
        default='{"human_type2": 1026}',
        help="--extra-fields 原始 JSON 字符串",
    )
    p.add_argument(
        "--tag",
        default="生活,日常,娱乐,按摩,减压,MASSAGE,日本,放松,美女,SPA",
        help="--tag",
    )
    p.add_argument(
        "-n",
        "--count",
        type=int,
        default=None,
        metavar="N",
        help="生成几条 biliup 命令（取待发布列表前 N 条）；省略则在终端提示输入",
    )
    args = p.parse_args()

    text = args.input.read_text(encoding="utf-8")
    all_rows = parse_plan_table(text)
    pending = [
        r
        for r in all_rows
        if norm_published_flag(r.published) != "Y" and r.video_rel.strip()
    ]

    want = resolve_count(args.count)
    if want > len(pending):
        print(
            f"提示：请求 {want} 条，待发布仅 {len(pending)} 条，已全部输出",
            file=sys.stderr,
        )
    selected = pending[:want]

    if not selected:
        print("错误：没有待发布记录可生成（或待发布列表为空）", file=sys.stderr)
        return 2

    script_dir = Path(__file__).resolve().parent
    temp_dir = script_dir / "temp"
    if args.output is not None:
        out_path = args.output
    else:
        try:
            out_path = default_output_sh_path(selected, temp_dir)
        except ValueError as e:
            print(f"错误：{e}", file=sys.stderr)
            return 2

    out = render_script(
        selected,
        base_dir=args.base_dir,
        publish_time=args.publish_time,
        source_url=args.source,
        tid=args.tid,
        extra_fields=args.extra_fields,
        tags=args.tag,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(out, encoding="utf-8", newline="\n")
    print(
        f"已写入 {out_path}：表中共 {len(all_rows)} 行，待发布 {len(pending)} 条，"
        f"本次生成 {len(selected)} 条命令",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
