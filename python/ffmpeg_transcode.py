"""Reusable FFmpeg probing, preview transcoding, and lossless splitting services."""

from __future__ import annotations

import functools
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterable

from ffmpeg_utils import get_ffmpeg_exe


VIDEO_PREVIEW_QUALITY_PROFILES = {
    "medium": {
        "label": "中",
        "preset": "medium",
        "video_bitrate": "4M",
        "maxrate": "5M",
        "bufsize": "8M",
        "audio_bitrate": "128k",
    },
    "high": {
        "label": "高",
        "preset": "medium",
        "video_bitrate": "10M",
        "maxrate": "12M",
        "bufsize": "20M",
        "audio_bitrate": "192k",
    },
}

GPU_VIDEO_ENCODERS = ("h264_nvenc", "h264_qsv", "h264_amf", "h264_mf")
H265_GPU_VIDEO_ENCODERS = ("hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_mf")
ALL_GPU_VIDEO_ENCODERS = (*GPU_VIDEO_ENCODERS, *H265_GPU_VIDEO_ENCODERS)
SOFTWARE_VIDEO_ENCODER = "libx264"
SOFTWARE_H265_VIDEO_ENCODER = "libx265"
GENERAL_TRANSCODE_CONTAINERS = {"mp4": ".mp4", "mov": ".mov", "mkv": ".mkv"}
GENERAL_TRANSCODE_QUALITY = {"high": 18, "balanced": 22, "small": 26}
GENERAL_TRANSCODE_H265_QUALITY = {"high": 21, "balanced": 25, "small": 29}
GENERAL_TRANSCODE_LONG_EDGE = {"original": None, "2160p": 3840, "1080p": 1920, "720p": 1280}
GENERAL_TRANSCODE_FRAME_RATES = {"original": None, "24": 24, "25": 25, "30": 30, "50": 50, "60": 60}
GENERAL_TRANSCODE_AUDIO = {"copy", "aac", "remove"}


class FFmpegTranscodeError(RuntimeError):
    """Raised when FFmpeg cannot complete a requested media operation."""


def normalize_video_preview_quality(quality: str) -> str:
    return quality if quality in VIDEO_PREVIEW_QUALITY_PROFILES else "medium"


def probe_media_text(input_path: str, timeout: float | None = 15) -> str:
    """Return FFmpeg's probe text for callers that need container metadata."""
    result = subprocess.run(
        [get_ffmpeg_exe(), "-hide_banner", "-i", input_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    return result.stderr or ""


def probe_creation_time_values(input_path: str, timeout: float | None = 15) -> tuple[str, ...]:
    """Return container creation-time metadata values in preference order."""
    metadata = probe_media_text(input_path, timeout=timeout)
    values: list[str] = []
    for key in ("com.apple.quicktime.creationdate", "creation_time", "date"):
        match = re.search(rf"(?im)^\s*{re.escape(key)}\s*:\s*(.+?)\s*$", metadata)
        if match:
            values.append(match.group(1))
    return tuple(values)


def probe_duration(input_path: str, timeout: float | None = None) -> float:
    """Read a media duration in seconds using the shared FFmpeg runtime."""
    metadata = probe_media_text(input_path, timeout=timeout)
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", metadata)
    if not match:
        raise FFmpegTranscodeError("无法读取视频时长，请检查文件是否完整或编码是否受支持")
    hours, minutes, seconds = match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    if duration <= 0:
        raise FFmpegTranscodeError("视频时长无效")
    return duration


@functools.lru_cache(maxsize=4)
def available_video_preview_encoders(ffmpeg_exe: str) -> tuple[str, ...]:
    try:
        result = subprocess.run(
            [ffmpeg_exe, "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            check=False,
        )
        output = result.stdout or ""
        supported = (*GPU_VIDEO_ENCODERS, SOFTWARE_VIDEO_ENCODER)
        return tuple(
            encoder
            for encoder in supported
            if re.search(rf"(?m)^\s*V\S*\s+{re.escape(encoder)}\s", output)
        )
    except (OSError, subprocess.SubprocessError):
        return (SOFTWARE_VIDEO_ENCODER,)


def video_preview_encoder_candidates(ffmpeg_exe: str | None = None) -> list[str]:
    executable = ffmpeg_exe or get_ffmpeg_exe()
    available = set(available_video_preview_encoders(executable))
    return [encoder for encoder in GPU_VIDEO_ENCODERS if encoder in available] + [SOFTWARE_VIDEO_ENCODER]


@functools.lru_cache(maxsize=4)
def available_h265_video_encoders(ffmpeg_exe: str) -> tuple[str, ...]:
    """Return the HEVC hardware encoders exposed by this FFmpeg runtime."""
    try:
        result = subprocess.run(
            [ffmpeg_exe, "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            check=False,
        )
        output = result.stdout or ""
        return tuple(
            encoder
            for encoder in H265_GPU_VIDEO_ENCODERS
            if re.search(rf"(?m)^\s*V\S*\s+{re.escape(encoder)}\s", output)
        )
    except (OSError, subprocess.SubprocessError):
        return ()


def general_transcode_encoder_candidates(ffmpeg_exe: str, video_mode: str) -> list[str]:
    if video_mode == "copy":
        return ["copy"]
    if video_mode == "h265":
        available = set(available_h265_video_encoders(ffmpeg_exe))
        return [
            encoder for encoder in H265_GPU_VIDEO_ENCODERS if encoder in available
        ] + [SOFTWARE_H265_VIDEO_ENCODER]
    return video_preview_encoder_candidates(ffmpeg_exe)


def build_video_preview_command(
    ffmpeg_exe: str,
    input_path: str,
    output_path: str,
    quality: str = "medium",
    encoder: str = SOFTWARE_VIDEO_ENCODER,
    hardware_decode: bool = False,
) -> list[str]:
    profile = VIDEO_PREVIEW_QUALITY_PROFILES[normalize_video_preview_quality(quality)]
    selected_encoder = encoder if encoder in (*GPU_VIDEO_ENCODERS, SOFTWARE_VIDEO_ENCODER) else SOFTWARE_VIDEO_ENCODER
    encoder_options = {
        "h264_nvenc": ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr"],
        "h264_qsv": ["-c:v", "h264_qsv", "-preset", "medium"],
        "h264_amf": ["-c:v", "h264_amf", "-quality", "balanced"],
        "h264_mf": ["-c:v", "h264_mf"],
        SOFTWARE_VIDEO_ENCODER: ["-c:v", SOFTWARE_VIDEO_ENCODER, "-preset", profile["preset"]],
    }[selected_encoder]
    return [
        ffmpeg_exe,
        "-y",
        *(["-hwaccel", "auto"] if hardware_decode else []),
        "-i",
        input_path,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt",
        "yuv420p",
        *encoder_options,
        "-b:v",
        profile["video_bitrate"],
        "-maxrate",
        profile["maxrate"],
        "-bufsize",
        profile["bufsize"],
        "-c:a",
        "aac",
        "-b:a",
        profile["audio_bitrate"],
        "-movflags",
        "+faststart",
        output_path,
    ]


def transcode_video_preview(
    input_path: str,
    output_path: str,
    quality: str = "medium",
    *,
    encoder_candidates: Iterable[str] | None = None,
    on_log: Callable[[str], None] | None = None,
) -> str:
    """Create one H.264 preview and return the encoder that succeeded."""
    ffmpeg_exe = get_ffmpeg_exe()
    candidates = list(encoder_candidates or video_preview_encoder_candidates(ffmpeg_exe))
    if SOFTWARE_VIDEO_ENCODER not in candidates:
        candidates.append(SOFTWARE_VIDEO_ENCODER)
    failed_gpu_encoders: set[str] = set()
    last_detail = "未知转码错误"

    for encoder in candidates:
        if encoder in failed_gpu_encoders:
            continue
        decode_attempts = (True, False) if encoder != SOFTWARE_VIDEO_ENCODER else (False,)
        for hardware_decode in decode_attempts:
            command = build_video_preview_command(
                ffmpeg_exe,
                input_path,
                output_path,
                quality,
                encoder,
                hardware_decode,
            )
            result = subprocess.run(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            if result.returncode == 0:
                return encoder
            detail_lines = (result.stderr or "").strip().splitlines()
            last_detail = detail_lines[-1] if detail_lines else "FFmpeg 转码失败"
        if encoder != SOFTWARE_VIDEO_ENCODER:
            failed_gpu_encoders.add(encoder)
            if on_log:
                on_log(f"GPU 编码器 {encoder} 不可用，将尝试其他编码器：{last_detail}")

    try:
        os.remove(output_path)
    except FileNotFoundError:
        pass
    raise FFmpegTranscodeError(last_detail)


def validate_general_transcode_options(
    *,
    container: str,
    video_mode: str,
    quality: str,
    resolution: str,
    frame_rate: str,
    audio_mode: str,
    output_mode: str,
) -> None:
    if container not in GENERAL_TRANSCODE_CONTAINERS:
        raise ValueError("不支持的输出封装")
    if video_mode not in {"copy", "h264", "h265"}:
        raise ValueError("不支持的视频编码模式")
    if quality not in GENERAL_TRANSCODE_QUALITY:
        raise ValueError("不支持的画质预设")
    if resolution not in GENERAL_TRANSCODE_LONG_EDGE:
        raise ValueError("不支持的输出分辨率")
    if frame_rate not in GENERAL_TRANSCODE_FRAME_RATES:
        raise ValueError("不支持的输出帧率")
    if audio_mode not in GENERAL_TRANSCODE_AUDIO:
        raise ValueError("不支持的音频处理方式")
    if output_mode not in {"new", "replace"}:
        raise ValueError("不支持的输出方式")
    if video_mode == "copy" and (resolution != "original" or frame_rate != "original"):
        raise ValueError("只更换封装时不能调整分辨率或帧率")


def build_general_transcode_command(
    ffmpeg_exe: str,
    input_path: str,
    output_path: str,
    *,
    container: str = "mp4",
    video_mode: str = "h264",
    quality: str = "balanced",
    resolution: str = "original",
    frame_rate: str = "original",
    audio_mode: str = "aac",
    encoder: str | None = None,
) -> list[str]:
    """Build a validated general-purpose video transcode command."""
    validate_general_transcode_options(
        container=container,
        video_mode=video_mode,
        quality=quality,
        resolution=resolution,
        frame_rate=frame_rate,
        audio_mode=audio_mode,
        output_mode="new",
    )
    command = [
        ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-i", input_path,
        "-map", "0:v:0", "-map", "0:a?",
        "-map_metadata", "0", "-map_chapters", "0",
    ]
    if video_mode == "copy":
        command.extend(["-c:v", "copy"])
    else:
        filters: list[str] = []
        long_edge = GENERAL_TRANSCODE_LONG_EDGE[resolution]
        if long_edge:
            filters.append(
                f"scale='min({long_edge},iw)':'min({long_edge},ih)'"
                ":force_original_aspect_ratio=decrease:force_divisible_by=2"
            )
        else:
            filters.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")
        target_frame_rate = GENERAL_TRANSCODE_FRAME_RATES[frame_rate]
        if target_frame_rate:
            filters.append(f"fps={target_frame_rate}")
        if video_mode == "h265":
            allowed_encoders = (*H265_GPU_VIDEO_ENCODERS, SOFTWARE_H265_VIDEO_ENCODER)
            selected_encoder = encoder if encoder in allowed_encoders else SOFTWARE_H265_VIDEO_ENCODER
            quality_value = GENERAL_TRANSCODE_H265_QUALITY[quality]
        else:
            allowed_encoders = (*GPU_VIDEO_ENCODERS, SOFTWARE_VIDEO_ENCODER)
            selected_encoder = encoder if encoder in allowed_encoders else SOFTWARE_VIDEO_ENCODER
            quality_value = GENERAL_TRANSCODE_QUALITY[quality]
        encoder_options = {
            "h264_nvenc": [
                "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq",
                "-rc", "vbr", "-cq", str(quality_value), "-b:v", "0",
            ],
            "h264_qsv": [
                "-c:v", "h264_qsv", "-preset", "medium",
                "-global_quality", str(quality_value),
            ],
            "h264_amf": [
                "-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp",
                "-qp_i", str(quality_value), "-qp_p", str(quality_value),
                "-qp_b", str(min(51, quality_value + 2)),
            ],
            "h264_mf": [
                "-c:v", "h264_mf", "-rate_control", "quality",
                "-quality", str({"high": 82, "balanced": 72, "small": 62}[quality]),
            ],
            SOFTWARE_VIDEO_ENCODER: [
                "-c:v", SOFTWARE_VIDEO_ENCODER, "-preset", "medium",
                "-crf", str(quality_value),
            ],
            "hevc_nvenc": [
                "-c:v", "hevc_nvenc", "-preset", "p4", "-tune", "hq",
                "-rc", "vbr", "-cq", str(quality_value), "-b:v", "0",
            ],
            "hevc_qsv": [
                "-c:v", "hevc_qsv", "-preset", "medium",
                "-global_quality", str(quality_value),
            ],
            "hevc_amf": [
                "-c:v", "hevc_amf", "-quality", "balanced", "-rc", "cqp",
                "-qp_i", str(quality_value), "-qp_p", str(quality_value),
            ],
            "hevc_mf": [
                "-c:v", "hevc_mf", "-rate_control", "quality",
                "-quality", str({"high": 82, "balanced": 72, "small": 62}[quality]),
            ],
            SOFTWARE_H265_VIDEO_ENCODER: [
                "-c:v", SOFTWARE_H265_VIDEO_ENCODER, "-preset", "medium",
                "-crf", str(quality_value),
            ],
        }[selected_encoder]
        command.extend([
            "-vf", ",".join(filters),
            *encoder_options,
            "-pix_fmt", "yuv420p",
        ])
    if audio_mode == "remove":
        command.append("-an")
    elif audio_mode == "aac":
        command.extend(["-c:a", "aac", "-b:a", "192k"])
    else:
        command.extend(["-c:a", "copy"])
    if container in {"mp4", "mov"}:
        if video_mode == "h265":
            command.extend(["-tag:v", "hvc1"])
        command.extend(["-movflags", "+faststart"])
    command.extend(["-progress", "pipe:1", "-nostats", output_path])
    return command


def _unique_transcode_output(
    input_path: str,
    container: str,
    directory: str | None = None,
    add_transcode_suffix: bool = True,
) -> str:
    directory = directory or os.path.dirname(input_path)
    stem = os.path.splitext(os.path.basename(input_path))[0]
    extension = GENERAL_TRANSCODE_CONTAINERS[container]
    output_stem = f"{stem}_转码" if add_transcode_suffix else stem
    candidate = os.path.join(directory, f"{output_stem}{extension}")
    sequence = 2
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{output_stem}_{sequence}{extension}")
        sequence += 1
    return candidate


def _create_unique_transcode_folder(source_folder: str) -> str:
    source_folder = os.path.abspath(os.path.normpath(source_folder))
    parent = os.path.dirname(source_folder)
    folder_name = os.path.basename(source_folder) or "视频"
    sequence = 2
    candidate = os.path.join(parent, f"{folder_name}_转码")
    while True:
        try:
            os.mkdir(candidate)
            return candidate
        except FileExistsError:
            candidate = os.path.join(parent, f"{folder_name}_转码_{sequence}")
            sequence += 1


def _path_is_inside(path_value: str, folder: str) -> bool:
    try:
        return os.path.normcase(os.path.commonpath((path_value, folder))) == os.path.normcase(folder)
    except ValueError:
        return False


def _retry_windows_sharing_violation(
    operation: Callable[[], object],
    cancel_check: Callable[[], None] | None = None,
    attempts: int = 12,
):
    """Retry a short-lived Windows sharing violation without hiding other errors."""
    for attempt in range(attempts):
        try:
            return operation()
        except OSError as error:
            if getattr(error, "winerror", None) not in {32, 33} or attempt + 1 >= attempts:
                raise
            if cancel_check:
                cancel_check()
            time.sleep(min(.15 * (attempt + 1), .75))


def transcode_video(
    input_path: str,
    *,
    container: str = "mp4",
    video_mode: str = "h264",
    quality: str = "balanced",
    resolution: str = "original",
    frame_rate: str = "original",
    audio_mode: str = "aac",
    output_mode: str = "new",
    destination_directory: str | None = None,
    on_progress: Callable[[float], None] | None = None,
    on_log: Callable[[str], None] | None = None,
    cancel_check: Callable[[], None] | None = None,
) -> str:
    """Transcode one video through a temporary file, then commit atomically."""
    validate_general_transcode_options(
        container=container,
        video_mode=video_mode,
        quality=quality,
        resolution=resolution,
        frame_rate=frame_rate,
        audio_mode=audio_mode,
        output_mode=output_mode,
    )
    input_path = os.path.abspath(input_path)
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"找不到视频：{input_path}")
    source_extension = os.path.splitext(input_path)[1].lower()
    output_extension = GENERAL_TRANSCODE_CONTAINERS[container]
    if destination_directory and output_mode == "replace":
        raise ValueError("文件夹转码任务不能替换原视频")
    if output_mode == "replace" and source_extension != output_extension:
        raise ValueError("替换原文件时输出封装必须与原文件扩展名一致")
    destination_directory = os.path.abspath(destination_directory) if destination_directory else None
    if destination_directory:
        os.makedirs(destination_directory, exist_ok=True)
    destination = input_path if output_mode == "replace" else _unique_transcode_output(
        input_path,
        container,
        destination_directory,
        add_transcode_suffix=not destination_directory,
    )
    temporary = os.path.join(
        os.path.dirname(destination),
        f".{os.path.splitext(os.path.basename(destination))[0]}.{uuid.uuid4().hex}.photoflow-transcode{output_extension}",
    )
    duration = probe_duration(input_path)
    ffmpeg_exe = get_ffmpeg_exe()
    encoder_candidates = general_transcode_encoder_candidates(ffmpeg_exe, video_mode)
    last_detail = "未知转码错误"

    try:
        for encoder in encoder_candidates:
            if cancel_check:
                cancel_check()
            try:
                _retry_windows_sharing_violation(lambda: os.remove(temporary), cancel_check)
            except FileNotFoundError:
                pass
            if on_log and encoder != "copy":
                backend = "GPU" if encoder in ALL_GPU_VIDEO_ENCODERS else "CPU"
                on_log(f"正在尝试 {backend} 编码器：{encoder}")
            command = build_general_transcode_command(
                ffmpeg_exe, input_path, temporary,
                container=container, video_mode=video_mode, quality=quality,
                resolution=resolution, frame_rate=frame_rate, audio_mode=audio_mode,
                encoder=encoder,
            )
            code, stderr = _run_general_transcode_attempt(command, duration, on_progress, cancel_check)
            if code == 0 and os.path.isfile(temporary) and os.path.getsize(temporary) > 0:
                try:
                    output_duration = probe_duration(temporary)
                    if output_duration <= 0 or abs(output_duration - duration) > max(2.0, duration * .05):
                        raise FFmpegTranscodeError("转码结果时长校验失败")
                except (FFmpegTranscodeError, OSError) as error:
                    last_detail = str(error)
                else:
                    if cancel_check:
                        cancel_check()
                    _retry_windows_sharing_violation(lambda: os.replace(temporary, destination), cancel_check)
                    if on_progress:
                        on_progress(100.0)
                    if on_log and encoder != "copy":
                        backend = "GPU" if encoder in ALL_GPU_VIDEO_ENCODERS else "CPU"
                        on_log(f"视频编码器：{encoder}（{backend}）")
                    return destination
            else:
                detail_lines = (stderr or "").strip().splitlines()
                last_detail = detail_lines[-1] if detail_lines else "FFmpeg 没有生成有效的转码文件"
            if encoder in ALL_GPU_VIDEO_ENCODERS and on_log:
                on_log(f"GPU 编码器 {encoder} 不可用，将尝试其他编码器：{last_detail}")
        if video_mode == "h265":
            raise FFmpegTranscodeError(f"H.265 硬件编码失败：{last_detail}")
        raise FFmpegTranscodeError(last_detail)
    finally:
        try:
            _retry_windows_sharing_violation(lambda: os.remove(temporary), cancel_check)
        except OSError:
            pass


def _run_general_transcode_attempt(
    command: list[str],
    duration: float,
    on_progress: Callable[[float], None] | None,
    cancel_check: Callable[[], None] | None,
) -> tuple[int, str]:
    """Run one encoder attempt and return its exit code and diagnostic output."""
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
    cancellation_errors: list[BaseException] = []
    watcher_done = threading.Event()

    def watch_cancellation():
        while not watcher_done.wait(.2) and process.poll() is None:
            if cancel_check is None:
                continue
            try:
                cancel_check()
            except BaseException as error:
                cancellation_errors.append(error)
                process.terminate()
                return

    watcher = threading.Thread(target=watch_cancellation, daemon=True)
    watcher.start()
    try:
        assert process.stdout is not None
        last_progress = -1.0
        for line in process.stdout:
            key, _, value = line.strip().partition("=")
            if key not in {"out_time_us", "out_time_ms"}:
                continue
            try:
                processed_seconds = float(value) / 1_000_000
            except ValueError:
                continue
            progress = max(0.0, min(99.0, processed_seconds / duration * 99.0))
            if on_progress and progress - last_progress >= .25:
                last_progress = progress
                on_progress(progress)
        code = process.wait()
        watcher_done.set()
        watcher.join(timeout=1)
        if cancellation_errors:
            raise cancellation_errors[0]
        error_output.seek(0)
        stderr = error_output.read()
        return code, stderr
    finally:
        watcher_done.set()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        error_output.close()


def _run_cancellable_process(command: list[str], cancel_check: Callable[[], None] | None) -> tuple[int, str]:
    if cancel_check is None:
        result = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        return result.returncode, result.stderr or ""

    process = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        while process.poll() is None:
            cancel_check()
            time.sleep(0.2)
        _stdout, stderr = process.communicate()
        return process.returncode, stderr or ""
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        raise


def split_video_by_size(
    input_path: str,
    *,
    split_threshold_bytes: int,
    target_segment_bytes: int,
    maximum_segment_bytes: int | None = None,
    keep_original: bool = False,
    cancel_check: Callable[[], None] | None = None,
) -> list[str]:
    """Losslessly and transactionally split one video into size-targeted segments."""
    input_path = os.path.abspath(input_path)
    if not os.path.isfile(input_path) or os.path.getsize(input_path) <= split_threshold_bytes:
        return []
    if cancel_check:
        cancel_check()

    total_seconds = probe_duration(input_path)
    segment_duration = total_seconds * (target_segment_bytes / os.path.getsize(input_path))
    source_dir = os.path.dirname(input_path)
    stem, extension = os.path.splitext(input_path)
    prefix = os.path.basename(stem) + "_part"
    existing = {
        name
        for name in os.listdir(source_dir)
        if name.startswith(prefix) and name.lower().endswith(extension.lower())
    }
    if existing:
        raise FFmpegTranscodeError(f"目标分段文件已经存在：{prefix}…{extension}")

    temporary_dir = os.path.join(source_dir, f".photoflow-split-{os.getpid()}-{time.time_ns()}")
    os.makedirs(temporary_dir, exist_ok=False)
    output_pattern = os.path.join(temporary_dir, f"{os.path.basename(stem)}_part%03d{extension}")
    committed_segments: list[str] = []
    try:
        temporary_segments: list[str] = []
        last_detail = "未生成完整且符合大小限制的分段"
        for attempt in range(5):
            for name in os.listdir(temporary_dir):
                candidate = os.path.join(temporary_dir, name)
                if os.path.isfile(candidate):
                    os.remove(candidate)
            code, stderr = _run_cancellable_process(
                [
                    get_ffmpeg_exe(),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-n",
                    "-i",
                    input_path,
                    "-map",
                    "0",
                    "-c",
                    "copy",
                    "-f",
                    "segment",
                    "-segment_time",
                    str(segment_duration),
                    "-reset_timestamps",
                    "1",
                    output_pattern,
                ],
                cancel_check,
            )
            if cancel_check:
                cancel_check()
            temporary_segments = sorted(
                os.path.join(temporary_dir, name)
                for name in os.listdir(temporary_dir)
                if name.startswith(prefix) and name.lower().endswith(extension.lower())
            )
            segment_sizes = [os.path.getsize(segment) for segment in temporary_segments]
            oversized_sizes = [size for size in segment_sizes if maximum_segment_bytes is not None and size > maximum_segment_bytes]
            sizes_are_valid = all(size > 0 for size in segment_sizes) and not oversized_sizes
            if code == 0 and len(temporary_segments) >= 2 and sizes_are_valid:
                break

            detail_lines = (stderr or "").strip().splitlines()
            if detail_lines:
                last_detail = detail_lines[-1]
            elif oversized_sizes and maximum_segment_bytes:
                largest_gib = max(oversized_sizes) / (1024 ** 3)
                limit_gib = maximum_segment_bytes / (1024 ** 3)
                last_detail = f"关键帧偏移导致最大分段为 {largest_gib:.2f} GiB，超过 {limit_gib:.2f} GiB 限制"
            if code != 0:
                raise FFmpegTranscodeError(last_detail)
            if attempt == 4:
                raise FFmpegTranscodeError(last_detail)

            # Stream-copy splitting can only cut on keyframes. Leave increasing
            # headroom when a keyframe lands after the estimated size boundary.
            if oversized_sizes and maximum_segment_bytes:
                observed_ratio = max(oversized_sizes) / maximum_segment_bytes
                segment_duration *= max(0.5, min(0.9, 0.92 / observed_ratio))
            else:
                segment_duration *= 0.75
        for temporary_segment in temporary_segments:
            final_segment = os.path.join(source_dir, os.path.basename(temporary_segment))
            if os.path.exists(final_segment):
                raise FileExistsError(f"目标分段文件已经存在：{os.path.basename(final_segment)}")
            os.replace(temporary_segment, final_segment)
            committed_segments.append(final_segment)
    except BaseException:
        for segment in committed_segments:
            try:
                os.remove(segment)
            except OSError:
                pass
        raise
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)

    if not keep_original:
        os.remove(input_path)
    return committed_segments


def _emit_cli(event_type: str, message: str, progress: float | None = None, **extra) -> None:
    payload = {"type": event_type, "message": message, **extra}
    if progress is not None:
        payload["progress"] = max(0, min(100, round(progress, 2)))
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def run(args_list=None) -> int:
    parser = argparse.ArgumentParser(description="PhotoFlow general video transcoder")
    parser.add_argument("paths", nargs="+", help="输入视频路径")
    parser.add_argument("--container", choices=sorted(GENERAL_TRANSCODE_CONTAINERS), default="mp4")
    parser.add_argument("--video-mode", choices=("h264", "h265", "copy"), default="h264")
    parser.add_argument("--quality", choices=sorted(GENERAL_TRANSCODE_QUALITY), default="balanced")
    parser.add_argument("--resolution", choices=tuple(GENERAL_TRANSCODE_LONG_EDGE), default="original")
    parser.add_argument("--frame-rate", choices=tuple(GENERAL_TRANSCODE_FRAME_RATES), default="original")
    parser.add_argument("--audio-mode", choices=sorted(GENERAL_TRANSCODE_AUDIO), default="aac")
    parser.add_argument("--output-mode", choices=("new", "replace"), default="new")
    parser.add_argument("--source-folder", action="append", default=[], help="所选来源文件夹；输出到其同级转码目录")
    parser.add_argument("--cancel_file", default="")
    args = parser.parse_args(args_list)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    paths = list(dict.fromkeys(os.path.abspath(value.strip('"').strip("'")) for value in args.paths))
    source_folders = list(dict.fromkeys(os.path.abspath(value) for value in args.source_folder))
    cancel_file = os.path.abspath(args.cancel_file) if args.cancel_file else ""

    class TranscodeCancelled(RuntimeError):
        pass

    def check_cancelled() -> None:
        if cancel_file and os.path.exists(cancel_file):
            raise TranscodeCancelled("视频转码已取消")

    outputs: list[str] = []
    try:
        validate_general_transcode_options(
            container=args.container, video_mode=args.video_mode, quality=args.quality,
            resolution=args.resolution, frame_rate=args.frame_rate,
            audio_mode=args.audio_mode, output_mode=args.output_mode,
        )
        if args.output_mode == "replace" and len(paths) != 1:
            raise ValueError("替换原文件只支持单个视频任务")
        if args.output_mode == "replace" and source_folders:
            raise ValueError("文件夹转码任务不能替换原视频")
        for folder in source_folders:
            if not os.path.isdir(folder):
                raise FileNotFoundError(f"找不到来源文件夹：{folder}")
        for path in paths:
            if not os.path.isfile(path):
                raise FileNotFoundError(f"找不到视频：{path}")
            if args.output_mode == "replace" and os.path.splitext(path)[1].lower() != GENERAL_TRANSCODE_CONTAINERS[args.container]:
                raise ValueError("替换原文件时输出封装必须与原文件扩展名一致")
        folder_destinations: dict[str, str] = {}
        destination_directories: dict[str, str] = {}
        for input_path in paths:
            containing_folders = [folder for folder in source_folders if _path_is_inside(input_path, folder)]
            if not containing_folders:
                continue
            source_folder = max(containing_folders, key=len)
            if source_folder not in folder_destinations:
                folder_destinations[source_folder] = _create_unique_transcode_folder(source_folder)
            relative_parent = os.path.dirname(os.path.relpath(input_path, source_folder))
            destination_directories[input_path] = os.path.normpath(
                os.path.join(folder_destinations[source_folder], relative_parent)
            )
        _emit_cli("log", f"准备转码 {len(paths)} 个视频")
        for source_folder, output_folder in folder_destinations.items():
            _emit_cli("log", f"文件夹输出：{source_folder} → {output_folder}")
        total_paths = len(paths)
        for index, path in enumerate(paths):
            check_cancelled()
            name = os.path.basename(path)
            item_count = f"（{index + 1}/{total_paths}）"
            active_backend = ""

            def item_status() -> str:
                if args.video_mode == "copy":
                    return f"正在处理：{name}{item_count}"
                if active_backend:
                    return f"正在编码（{active_backend}）：{name}{item_count}"
                return f"正在准备编码：{name}{item_count}"

            def emit_transcode_log(message: str) -> None:
                nonlocal active_backend
                _emit_cli("log", message)
                backend_match = re.match(r"正在尝试 (GPU|CPU) 编码器：", message)
                if backend_match:
                    active_backend = backend_match.group(1)
                    _emit_cli("status", item_status())

            def emit_transcode_progress(item_progress: float) -> None:
                _emit_cli(
                    "progress",
                    item_status(),
                    (index + item_progress / 100) / total_paths * 100,
                )

            _emit_cli(
                "progress",
                item_status(),
                index / total_paths * 100,
                data={"fileStarted": True},
            )
            output = transcode_video(
                path,
                container=args.container,
                video_mode=args.video_mode,
                quality=args.quality,
                resolution=args.resolution,
                frame_rate=args.frame_rate,
                audio_mode=args.audio_mode,
                output_mode=args.output_mode,
                destination_directory=destination_directories.get(path),
                on_progress=emit_transcode_progress,
                on_log=emit_transcode_log,
                cancel_check=check_cancelled,
            )
            outputs.append(output)
            _emit_cli("log", f"已生成：{output}")
        _emit_cli(
            "success",
            f"视频转码完成，共处理 {len(outputs)} 个文件",
            100,
            outputs=outputs,
            folderOutputs=[
                {"sourceFolder": source_folder, "outputFolder": output_folder}
                for source_folder, output_folder in folder_destinations.items()
            ],
        )
        return 0
    except TranscodeCancelled as error:
        _emit_cli("cancelled", str(error), outputs=outputs)
        return 0
    except Exception as error:
        _emit_cli("error", str(error), outputs=outputs)
        return 1
    finally:
        if cancel_file:
            try:
                os.remove(cancel_file)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
