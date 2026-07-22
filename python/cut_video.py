"""Losslessly split large videos into approximately 3.95 GB segments."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading

from ffmpeg_utils import get_ffmpeg_exe


TARGET_SIZE = int(3.95 * 1024 * 1024 * 1024)


def emit(event_type: str, message: str, progress: float | None = None, **extra):
    payload = {"type": event_type, "message": message, **extra}
    if progress is not None:
        payload["progress"] = max(0, min(100, round(progress, 2)))
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def probe_duration(ffmpeg_exe: str, input_file: str) -> float:
    result = subprocess.run(
        [ffmpeg_exe, "-hide_banner", "-i", input_file],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        raise RuntimeError("无法读取视频时长，请检查文件是否完整或编码是否受支持")
    hours, minutes, seconds = match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    if duration <= 0:
        raise RuntimeError("视频时长无效")
    return duration


def fast_lossless_split(input_file: str, output_dir: str | None = None, output_stem: str | None = None):
    input_file = os.path.abspath(input_file)
    if not os.path.isfile(input_file):
        raise FileNotFoundError(f"找不到文件：{input_file}")

    file_size = os.path.getsize(input_file)
    if file_size <= TARGET_SIZE:
        emit("success", "视频小于 4GB，无需分割", 100, outputs=[])
        return []

    ffmpeg_exe = get_ffmpeg_exe()
    emit("progress", f"正在分析视频：{os.path.basename(input_file)}", 2)
    total_seconds = probe_duration(ffmpeg_exe, input_file)
    part_count = math.ceil(file_size / TARGET_SIZE)
    segment_duration = total_seconds / part_count

    destination = os.path.abspath(output_dir or os.path.dirname(input_file))
    os.makedirs(destination, exist_ok=True)
    stem = output_stem or os.path.splitext(os.path.basename(input_file))[0]
    if not stem or stem in {".", ".."} or os.path.basename(stem) != stem:
        raise ValueError("输出文件名前缀无效")
    extension = os.path.splitext(input_file)[1]
    output_pattern = os.path.join(destination, f"{stem}_part%03d{extension}")

    emit("log", f"视频大小 {file_size / 1024**3:.2f} GB，预计分为 {part_count} 段")
    command = [
        ffmpeg_exe,
        "-hide_banner",
        "-y",
        "-i", input_file,
        "-map", "0",
        "-c", "copy",
        "-f", "segment",
        "-segment_time", str(segment_duration),
        "-reset_timestamps", "1",
        "-progress", "pipe:1",
        "-nostats",
        output_pattern,
    ]
    error_output = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=error_output,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    cancelled = threading.Event()

    def monitor_control():
        for line in sys.stdin:
            if line.strip().casefold() != "cancel":
                continue
            cancelled.set()
            process.terminate()
            return

    threading.Thread(target=monitor_control, daemon=True).start()
    assert process.stdout is not None
    last_progress = 5.0
    for line in process.stdout:
        key, _, value = line.strip().partition("=")
        if key not in {"out_time_us", "out_time_ms"}:
            continue
        try:
            # Modern ffmpeg reports microseconds for both keys in progress mode.
            processed_seconds = float(value) / 1_000_000
        except ValueError:
            continue
        progress = min(98.0, 5.0 + processed_seconds / total_seconds * 93.0)
        if progress - last_progress >= 0.5:
            last_progress = progress
            emit("progress", f"正在无损分割：{os.path.basename(input_file)}", progress)

    code = process.wait()
    error_output.seek(0)
    stderr = error_output.read()
    error_output.close()
    if cancelled.is_set():
        raise RuntimeError("视频分割已取消")
    if code != 0:
        raise RuntimeError(stderr.strip()[-2000:] or f"FFmpeg 分割失败，退出代码 {code}")

    prefix = f"{stem}_part"
    outputs = sorted(
        os.path.join(destination, name)
        for name in os.listdir(destination)
        if name.startswith(prefix) and os.path.splitext(name)[1].lower() == extension.lower()
    )
    outputs = [item for item in outputs if os.path.isfile(item) and os.path.getsize(item) > 0]
    if len(outputs) < 2:
        raise RuntimeError("视频分割没有生成完整的分段文件")
    emit("success", f"视频分割完成，共 {len(outputs)} 段", 100, outputs=outputs)
    return outputs


def run(args_list=None):
    parser = argparse.ArgumentParser(description="Fast lossless video splitter")
    parser.add_argument("video_path", help="Path to the input video")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--output-stem", default=None)
    args = parser.parse_args(args_list)
    try:
        fast_lossless_split(
            args.video_path.strip('"').strip("'"),
            output_dir=args.output_dir,
            output_stem=args.output_stem,
        )
        return 0
    except Exception as error:
        emit("error", str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
