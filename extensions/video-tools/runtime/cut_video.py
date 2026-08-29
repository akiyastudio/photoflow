"""Losslessly split large videos into approximately 3.95 GB segments."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid

from ffmpeg_transcode import probe_duration
from ffmpeg_utils import get_ffmpeg_exe


TARGET_SIZE = int(3.95 * 1024 * 1024 * 1024)
MAXIMUM_SIZE = TARGET_SIZE
MAX_SPLIT_ATTEMPTS = 6
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


def trim_video_exactly(
    input_file: str,
    start_seconds: float,
    end_seconds: float,
    output_file: str,
    cancel_file: str | None = None,
):
    """Decode from the requested start and encode exactly the selected interval."""
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
    requested_duration = end_seconds - start_seconds
    # Stream-copy trimming can only begin on an existing keyframe. Its reported
    # duration may look right while its first and last pictures are not the ones
    # selected in the editor. Manual trimming therefore always decodes to the
    # requested timestamp and re-encodes the selected interval.
    command = [
        ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-i", input_file,
        "-ss", f"{start_seconds:.6f}", "-t", f"{requested_duration:.6f}",
        "-map", "0:v:0?", "-map", "0:a?", "-map_metadata", "0", "-map_chapters", "0",
        "-c:v", "libx264", "-preset", "medium", "-crf", "16",
        "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats", temporary,
    ]
    process = None
    try:
        if cancel_file and os.path.isfile(cancel_file):
            raise SplitCancelled("视频导出已取消")
        emit("progress", "正在准备视频…", 2, phase="preparing")
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
        )
        last_progress = 2.0
        for raw_line in process.stdout or []:
            if cancel_file and os.path.isfile(cancel_file):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                raise SplitCancelled("视频导出已取消")
            key, separator, value = raw_line.strip().partition("=")
            if not separator or key not in {"out_time_us", "out_time_ms"}:
                continue
            try:
                processed_seconds = max(0.0, float(value) / 1_000_000.0)
            except ValueError:
                continue
            progress = min(92.0, 5.0 + processed_seconds / requested_duration * 87.0)
            if progress - last_progress >= 0.5:
                last_progress = progress
                emit("progress", "正在导出视频…", progress, phase="encoding")
        return_code = process.wait()
        error_output = (process.stderr.read() if process.stderr else "").strip()
        if cancel_file and os.path.isfile(cancel_file):
            raise SplitCancelled("视频导出已取消")
        if return_code != 0 or not os.path.isfile(temporary) or os.path.getsize(temporary) <= 0:
            raise RuntimeError(error_output[-2000:] or "FFmpeg 未能生成精确剪辑结果")
        emit("progress", "正在校验导出结果…", 95, phase="verifying")
        output_duration = probe_duration(temporary)
        duration_tolerance = max(0.12, min(0.35, requested_duration * 0.03))
        if abs(output_duration - requested_duration) > duration_tolerance:
            raise RuntimeError(f"剪辑结果时长异常：期望 {requested_duration:.2f} 秒，实际 {output_duration:.2f} 秒")
        emit("progress", "正在保存视频…", 98, phase="saving")
        os.replace(temporary, output_file)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
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
        "outputDuration": output_duration,
        "exactTranscodeUsed": True,
    }
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def trim_video_fast(
    input_file: str,
    start_seconds: float,
    end_seconds: float,
    output_file: str,
    cancel_file: str | None = None,
):
    """Copy encoded packets into a new container without re-encoding them."""
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
    requested_duration = end_seconds - start_seconds
    command = [
        ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-ss", f"{start_seconds:.6f}", "-i", input_file,
        "-t", f"{requested_duration:.6f}",
        "-map", "0:v:0?", "-map", "0:a?", "-map_metadata", "0", "-map_chapters", "0",
        # Keep the pre-roll packets and their original timestamps. The MP4/MOV
        # muxer writes an edit list that hides frames before the requested
        # timestamp while retaining the keyframe data needed to decode the
        # first visible frame. Rebasing negative timestamps would expose that
        # pre-roll and incorrectly lengthen the exported clip.
        "-c", "copy",
    ]
    if extension.lower() in {".mp4", ".mov", ".m4v"}:
        command.extend(["-movflags", "+faststart"])
    command.extend(["-progress", "pipe:1", "-nostats", temporary])
    process = None
    try:
        if cancel_file and os.path.isfile(cancel_file):
            raise SplitCancelled("视频导出已取消")
        emit("progress", "正在准备快速导出…", 2, phase="preparing")
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
        )
        last_progress = 2.0
        for raw_line in process.stdout or []:
            if cancel_file and os.path.isfile(cancel_file):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                raise SplitCancelled("视频导出已取消")
            key, separator, value = raw_line.strip().partition("=")
            if not separator or key not in {"out_time_us", "out_time_ms"}:
                continue
            try:
                processed_seconds = max(0.0, float(value) / 1_000_000.0)
            except ValueError:
                continue
            progress = min(92.0, 5.0 + processed_seconds / requested_duration * 87.0)
            if progress - last_progress >= 0.5:
                last_progress = progress
                emit("progress", "正在快速导出视频…", progress, phase="copying")
        return_code = process.wait()
        error_output = (process.stderr.read() if process.stderr else "").strip()
        if cancel_file and os.path.isfile(cancel_file):
            raise SplitCancelled("视频导出已取消")
        if return_code != 0 or not os.path.isfile(temporary) or os.path.getsize(temporary) <= 0:
            detail = error_output[-2000:] or "FFmpeg 未能生成快速剪辑结果"
            raise RuntimeError(f"快速导出失败，可在设置中切换为精确导出：{detail}")
        emit("progress", "正在校验导出结果…", 95, phase="verifying")
        output_duration = probe_duration(temporary)
        duration_tolerance = max(3.0, min(10.0, requested_duration * 0.1))
        if output_duration < 0.05 or abs(output_duration - requested_duration) > duration_tolerance:
            raise RuntimeError(
                f"快速导出结果时长异常：期望 {requested_duration:.2f} 秒，实际 {output_duration:.2f} 秒"
            )
        emit("progress", "正在保存视频…", 98, phase="saving")
        os.replace(temporary, output_file)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass
    result = {
        "success": True,
        "output": output_file,
        "start": start_seconds,
        "end": end_seconds,
        "duration": requested_duration,
        "sourceDuration": duration,
        "outputDuration": output_duration,
        "exactTranscodeUsed": False,
        "fastCopyUsed": True,
        "boundaryMaySnap": True,
    }
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


# Kept as a compatibility alias for callers from older releases.
trim_video_losslessly = trim_video_exactly


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
    last_item_progress = -1.0

    def report(message: str, item_progress: float):
        nonlocal last_item_progress
        item_progress = max(last_item_progress, max(0.0, min(100.0, item_progress)))
        last_item_progress = item_progress
        overall = progress_start + (progress_end - progress_start) * max(0.0, min(100.0, item_progress)) / 100.0
        emit("progress", message, overall)

    def check_cancelled():
        if cancel_file and os.path.isfile(cancel_file):
            raise SplitCancelled("视频分割已取消")

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
    check_cancelled()
    total_seconds = probe_duration(input_file)
    segment_duration = total_seconds * (TARGET_SIZE / file_size)

    destination = os.path.abspath(output_dir or os.path.dirname(input_file))
    os.makedirs(destination, exist_ok=True)
    stem = output_stem or os.path.splitext(os.path.basename(input_file))[0]
    if not stem or stem in {".", ".."} or os.path.basename(stem) != stem:
        raise ValueError("输出文件名前缀无效")
    extension = os.path.splitext(input_file)[1]
    prefix = f"{stem}_part"
    existing_outputs = [
        name for name in os.listdir(destination)
        if name.startswith(prefix)
        and name[len(prefix):-len(extension) if extension else None].isdigit()
        and os.path.splitext(name)[1].lower() == extension.lower()
    ]
    if existing_outputs:
        raise FileExistsError(f"目标分段文件已经存在：{existing_outputs[0]}")

    estimated_parts = max(2, (file_size + TARGET_SIZE - 1) // TARGET_SIZE)
    emit("log", f"视频大小 {file_size / 1024**3:.2f} GB，预计分为至少 {estimated_parts} 段")
    temporary_dir = tempfile.mkdtemp(prefix=".photoflow-split-", dir=destination)
    output_pattern = os.path.join(temporary_dir, f"{stem}_part%03d{extension}")
    committed_outputs = []
    outputs = []
    try:
        last_detail = "未生成完整且符合大小限制的分段"
        for attempt in range(MAX_SPLIT_ATTEMPTS):
            check_cancelled()
            for name in os.listdir(temporary_dir):
                candidate = os.path.join(temporary_dir, name)
                if os.path.isfile(candidate):
                    os.remove(candidate)
            if attempt:
                emit("warning", f"检测到分段超过 3.95 GB，正在缩短分段并重试（{attempt + 1}/{MAX_SPLIT_ATTEMPTS}）")

            command = [
                ffmpeg_exe,
                "-hide_banner",
                "-n",
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
            try:
                assert process.stdout is not None
                for line in process.stdout:
                    if cancel_file and os.path.isfile(cancel_file):
                        process.terminate()
                        process.wait()
                        raise SplitCancelled("视频分割已取消")
                    key, _, value = line.strip().partition("=")
                    if key not in {"out_time_us", "out_time_ms"}:
                        continue
                    try:
                        processed_seconds = float(value) / 1_000_000
                    except ValueError:
                        continue
                    progress = min(96.0, 5.0 + processed_seconds / total_seconds * 91.0)
                    if progress - last_item_progress >= 0.5:
                        report(f"正在无损分割：{os.path.basename(input_file)}", progress)
                code = process.wait()
            except BaseException:
                if process.poll() is None:
                    process.terminate()
                    process.wait()
                raise
            finally:
                error_output.seek(0)
                stderr = error_output.read()
                error_output.close()

            check_cancelled()
            temporary_outputs = sorted(
                os.path.join(temporary_dir, name)
                for name in os.listdir(temporary_dir)
                if name.startswith(prefix) and os.path.splitext(name)[1].lower() == extension.lower()
            )
            segment_sizes = [os.path.getsize(item) for item in temporary_outputs]
            oversized_sizes = [size for size in segment_sizes if size > MAXIMUM_SIZE]
            if code == 0 and len(temporary_outputs) >= 2 and all(size > 0 for size in segment_sizes) and not oversized_sizes:
                outputs = temporary_outputs
                break

            detail_lines = (stderr or "").strip().splitlines()
            if detail_lines:
                last_detail = detail_lines[-1]
            elif oversized_sizes:
                last_detail = f"关键帧偏移导致最大分段为 {max(oversized_sizes) / 1024**3:.2f} GB，超过 3.95 GB 限制"
            if code != 0:
                raise RuntimeError(last_detail)
            if attempt == MAX_SPLIT_ATTEMPTS - 1:
                raise RuntimeError(last_detail)

            if oversized_sizes:
                observed_ratio = max(oversized_sizes) / MAXIMUM_SIZE
                segment_duration *= max(0.35, min(0.85, 0.90 / observed_ratio))
            else:
                segment_duration *= 0.7

        if not outputs:
            raise RuntimeError(last_detail)
        for temporary_output in outputs:
            final_output = os.path.join(destination, os.path.basename(temporary_output))
            if os.path.exists(final_output):
                raise FileExistsError(f"目标分段文件已经存在：{os.path.basename(final_output)}")
            os.replace(temporary_output, final_output)
            committed_outputs.append(final_output)
        outputs = committed_outputs
    except BaseException:
        for output in committed_outputs:
            try:
                os.remove(output)
            except OSError:
                pass
        raise
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)

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
    parser.add_argument("--trim-mode", choices=("fast", "exact"), default="fast")
    parser.add_argument("--cancel_file", default="")
    args = parser.parse_args(args_list)
    try:
        trim_requested = args.trim_start is not None or args.trim_end is not None or args.output_path is not None
        if trim_requested:
            if len(args.video_path) != 1:
                raise ValueError("剪辑视频仅支持单个输入文件")
            if args.trim_start is None or args.trim_end is None or not args.output_path:
                raise ValueError("剪辑视频需要开始时间、结束时间和输出路径")
            trim_function = trim_video_fast if args.trim_mode == "fast" else trim_video_exactly
            trim_function(
                args.video_path[0].strip('"').strip("'"),
                args.trim_start,
                args.trim_end,
                args.output_path,
                args.cancel_file or None,
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
