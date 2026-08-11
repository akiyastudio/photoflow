"""Losslessly split large videos into approximately 3.95 GB segments."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import uuid

from ffmpeg_transcode import probe_duration
from ffmpeg_utils import get_ffmpeg_exe


TARGET_SIZE = int(3.95 * 1024 * 1024 * 1024)
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".crm", ".mts", ".m2ts", ".ts"}


class SplitCancelled(RuntimeError):
    pass


def configure_text_streams():
    """Keep JSON events UTF-8 when the Windows system code page is not UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="backslashreplace")


configure_text_streams()


def emit(event_type: str, message: str, progress: float | None = None, **extra):
    payload = {"type": event_type, "message": message, **extra}
    if progress is not None:
        payload["progress"] = max(0, min(100, round(progress, 2)))
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def trim_video_losslessly(input_file: str, start_seconds: float, end_seconds: float, output_file: str):
    """Create a stream-copy trim so codecs, bitrates and pixel data stay unchanged."""
    input_file = os.path.abspath(input_file)
    output_file = os.path.abspath(output_file)
    if not os.path.isfile(input_file):
        raise FileNotFoundError(f"找不到文件：{input_file}")
    if os.path.normcase(input_file) == os.path.normcase(output_file):
        raise ValueError("剪辑结果不能覆盖原视频")
    ffmpeg_exe = get_ffmpeg_exe()
    duration = probe_duration(input_file)
    start_seconds = max(0.0, float(start_seconds))
    end_seconds = min(duration, float(end_seconds))
    if end_seconds - start_seconds < 0.05:
        raise ValueError("保留片段的时长必须大于 0.05 秒")
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    extension = os.path.splitext(output_file)[1]
    temporary = os.path.join(
        os.path.dirname(output_file),
        f".{os.path.splitext(os.path.basename(output_file))[0]}.{uuid.uuid4().hex}.photoflow-part{extension}",
    )
    command = [
        ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-ss", f"{start_seconds:.6f}", "-i", input_file,
        "-t", f"{end_seconds - start_seconds:.6f}",
        "-map", "0", "-map_metadata", "0", "-map_chapters", "0",
        "-c", "copy", "-avoid_negative_ts", "make_zero", temporary,
    ]
    try:
        completed = subprocess.run(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", check=False,
        )
        if completed.returncode != 0 or not os.path.isfile(temporary) or os.path.getsize(temporary) <= 0:
            raise RuntimeError(completed.stderr.strip()[-2000:] or "FFmpeg 未能生成剪辑结果")
        os.replace(temporary, output_file)
    finally:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass
    result = {
        "success": True,
        "output": output_file,
        "start": start_seconds,
        "end": end_seconds,
        "duration": end_seconds - start_seconds,
        "sourceDuration": duration,
    }
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def fast_lossless_split(
    input_file: str,
    output_dir: str | None = None,
    output_stem: str | None = None,
    progress_range: tuple[float, float] = (0.0, 100.0),
    emit_completion: bool = True,
    cancel_file: str | None = None,
):
    input_file = os.path.abspath(input_file)
    if not os.path.isfile(input_file):
        raise FileNotFoundError(f"找不到文件：{input_file}")

    progress_start, progress_end = progress_range

    def report(message: str, item_progress: float):
        overall = progress_start + (progress_end - progress_start) * max(0.0, min(100.0, item_progress)) / 100.0
        emit("progress", message, overall)

    file_size = os.path.getsize(input_file)
    if file_size <= TARGET_SIZE:
        if emit_completion:
            emit("success", "视频小于 4GB，无需分割", progress_end, outputs=[])
        else:
            emit("log", f"{os.path.basename(input_file)} 小于 4GB，无需分割")
            report(f"已检查：{os.path.basename(input_file)}", 100)
        return []

    ffmpeg_exe = get_ffmpeg_exe()
    report(f"正在分析视频：{os.path.basename(input_file)}", 2)
    total_seconds = probe_duration(input_file)
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
        if cancel_file and os.path.isfile(cancel_file):
            cancelled.set()
            process.terminate()
            break
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
            report(f"正在无损分割：{os.path.basename(input_file)}", progress)

    code = process.wait()
    error_output.seek(0)
    stderr = error_output.read()
    error_output.close()
    if cancelled.is_set():
        raise SplitCancelled("视频分割已取消")
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
    if emit_completion:
        emit("success", f"视频分割完成，共 {len(outputs)} 段", progress_end, outputs=outputs)
    else:
        emit("log", f"{os.path.basename(input_file)} 分割完成，共 {len(outputs)} 段")
        report(f"已完成：{os.path.basename(input_file)}", 100)
    return outputs


def collect_video_inputs(raw_paths):
    videos = []
    seen = set()
    skipped = []
    for raw_path in raw_paths:
        target = os.path.abspath(raw_path.strip('"').strip("'"))
        if os.path.isfile(target):
            candidates = [target] if os.path.splitext(target)[1].lower() in VIDEO_EXTENSIONS else []
            if not candidates:
                skipped.append(target)
        elif os.path.isdir(target):
            candidates = []
            for directory, directory_names, file_names in os.walk(target):
                directory_names.sort(key=str.casefold)
                for file_name in sorted(file_names, key=str.casefold):
                    candidate = os.path.join(directory, file_name)
                    if os.path.splitext(candidate)[1].lower() in VIDEO_EXTENSIONS:
                        candidates.append(candidate)
        else:
            candidates = []
            skipped.append(target)
        for candidate in candidates:
            key = os.path.normcase(os.path.abspath(candidate))
            if key in seen:
                continue
            seen.add(key)
            videos.append(candidate)
    return videos, skipped


def run(args_list=None):
    parser = argparse.ArgumentParser(description="Fast lossless video splitter")
    parser.add_argument("video_path", nargs="+", help="Path(s) to input videos or folders")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--output-stem", default=None)
    parser.add_argument("--trim-start", type=float)
    parser.add_argument("--trim-end", type=float)
    parser.add_argument("--output-path")
    parser.add_argument("--cancel_file", default="")
    args = parser.parse_args(args_list)
    try:
        trim_requested = args.trim_start is not None or args.trim_end is not None or args.output_path is not None
        if trim_requested:
            if len(args.video_path) != 1:
                raise ValueError("剪辑视频仅支持单个输入文件")
            if args.trim_start is None or args.trim_end is None or not args.output_path:
                raise ValueError("剪辑视频需要开始时间、结束时间和输出路径")
            trim_video_losslessly(
                args.video_path[0].strip('"').strip("'"),
                args.trim_start,
                args.trim_end,
                args.output_path,
            )
            return 0
        videos, skipped = collect_video_inputs(args.video_path)
        for skipped_path in skipped:
            emit("warning", f"不是支持的视频文件或路径不存在，已跳过：{skipped_path}")
        if not videos:
            raise ValueError("所选内容中没有支持的视频")
        if (args.output_dir or args.output_stem) and len(videos) != 1:
            raise ValueError("自定义输出目录或文件名仅支持单个视频")
        failures = []
        split_video_count = 0
        output_count = 0
        for index, video_path in enumerate(videos):
            if args.cancel_file and os.path.isfile(args.cancel_file):
                raise SplitCancelled("视频分割已取消")
            try:
                outputs = fast_lossless_split(
                    video_path,
                    output_dir=args.output_dir,
                    output_stem=args.output_stem,
                    progress_range=(index / len(videos) * 100, (index + 1) / len(videos) * 100),
                    emit_completion=False,
                    cancel_file=args.cancel_file or None,
                )
                if outputs:
                    split_video_count += 1
                    output_count += len(outputs)
            except SplitCancelled:
                raise
            except Exception as error:
                failures.append((video_path, str(error)))
                emit("warning", f"{os.path.basename(video_path)} 处理失败：{error}")
        if len(failures) == len(videos):
            raise RuntimeError(f"全部 {len(videos)} 个视频处理失败")
        emit(
            "success",
            f"批量切割完成：检查 {len(videos)} 个视频，切割 {split_video_count} 个，生成 {output_count} 个分段"
            + (f"，失败 {len(failures)} 个" if failures else ""),
            100,
            outputsCount=output_count,
            failedCount=len(failures),
        )
        return 0
    except SplitCancelled as error:
        emit("cancelled", str(error))
        return 1
    except Exception as error:
        emit("error", str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
