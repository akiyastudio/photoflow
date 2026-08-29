"""Reusable FFmpeg probing, preview transcoding, and lossless splitting services."""

from __future__ import annotations

import functools
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterable

from ffmpeg_utils import get_ffmpeg_exe
from send2trash import send2trash


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
AV1_GPU_VIDEO_ENCODERS = ("av1_nvenc", "av1_qsv", "av1_amf")
ALL_GPU_VIDEO_ENCODERS = (*GPU_VIDEO_ENCODERS, *H265_GPU_VIDEO_ENCODERS, *AV1_GPU_VIDEO_ENCODERS)
SOFTWARE_VIDEO_ENCODER = "libx264"
SOFTWARE_H265_VIDEO_ENCODER = "libx265"
PRORES_VIDEO_ENCODER = "prores_ks"
GENERAL_TRANSCODE_CONTAINERS = {"mp4": ".mp4", "mov": ".mov", "mkv": ".mkv"}
GENERAL_TRANSCODE_QUALITY = {"high": 18, "balanced": 22, "small": 26}
GENERAL_TRANSCODE_H265_QUALITY = {"high": 21, "balanced": 25, "small": 29}
GENERAL_TRANSCODE_AV1_QUALITY = {"high": 24, "balanced": 29, "small": 34}
GENERAL_TRANSCODE_LONG_EDGE = {"original": None, "2160p": 3840, "1080p": 1920, "720p": 1280}
GENERAL_TRANSCODE_FRAME_RATES = {"original": None, "24": 24, "25": 25, "30": 30, "50": 50, "60": 60}
GENERAL_TRANSCODE_AUDIO = {"copy", "aac", "remove"}
GENERAL_TRANSCODE_SUBTITLES = {"copy", "burn", "remove"}
GENERAL_TRANSCODE_COLOR_MODES = {"auto", "sdr", "hdr10", "hlg", "hdr-to-sdr"}
GENERAL_TRANSCODE_BIT_DEPTHS = {"auto", "8", "10"}
GENERAL_TRANSCODE_FRAME_RATE_MODES = {"preserve", "cfr", "vfr"}
GENERAL_TRANSCODE_ROTATIONS = {"auto", "0", "90", "180", "270"}
GENERAL_TRANSCODE_ASPECT_MODES = {"preserve", "square-pixels"}
GENERAL_TRANSCODE_AUDIO_TRACKS = {"all", "first"}
GENERAL_TRANSCODE_INPUT_EXTENSIONS = {
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".wmv",
    ".crm", ".mts", ".m2ts", ".ts",
}


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


def _parse_ratio(value: str) -> float | None:
    try:
        numerator, separator, denominator = value.strip().partition("/")
        result = float(numerator) / float(denominator) if separator else float(numerator)
        return result if result > 0 else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def probe_media_info(input_path: str, timeout: float | None = 20) -> dict:
    """Return the fields needed by presets, HDR routing and output estimation.

    The audited runtime intentionally ships one FFmpeg executable instead of a
    second, mostly duplicate ffprobe binary.  FFmpeg's stable stream summary is
    parsed defensively; unknown fields remain explicit rather than being guessed.
    """
    input_path = os.path.abspath(input_path)
    text = probe_media_text(input_path, timeout=timeout)
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    duration = 0.0
    if duration_match:
        hours, minutes, seconds = duration_match.groups()
        duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    container_bitrate_match = re.search(r"Duration:.*?bitrate:\s*(\d+)\s*kb/s", text, re.S)
    video_lines = re.findall(r"(?im)^\s*Stream\s+#\S+.*?:\s*Video:\s*(.+)$", text)
    audio_lines = re.findall(r"(?im)^\s*Stream\s+#\S+.*?:\s*Audio:\s*(.+)$", text)
    subtitle_lines = re.findall(r"(?im)^\s*Stream\s+#\S+.*?:\s*Subtitle:\s*(.+)$", text)
    video = video_lines[0] if video_lines else ""
    codec = video.split(",", 1)[0].strip().split()[0] if video else "unknown"
    pixel_match = re.search(r",\s*([a-z][a-z0-9_]*(?:10|12|16)?(?:le|be)?)(?:\([^)]*\))?\s*,", video, re.I)
    pixel_format = pixel_match.group(1).lower() if pixel_match else "unknown"
    profile_match = re.search(r"\((Main 10|Main|High 10|High|[^,)]+)\)", video, re.I)
    profile = profile_match.group(1) if profile_match else ""
    bit_depth_match = re.search(r"(?:p|yuv\d+p|gbrp)(10|12|16)(?:le|be)?", pixel_format)
    bit_depth = int(bit_depth_match.group(1)) if bit_depth_match else (10 if "10" in profile else 8)
    dimensions = re.search(r"(?:^|,\s*)(\d{2,5})x(\d{2,5})(?:\s|,|$)", video)
    width = int(dimensions.group(1)) if dimensions else 0
    height = int(dimensions.group(2)) if dimensions else 0
    fps_match = re.search(r"([\d.]+)\s*fps", video)
    fps = float(fps_match.group(1)) if fps_match else 0.0
    sar_match = re.search(r"SAR\s+(\d+:\d+)", video)
    dar_match = re.search(r"DAR\s+(\d+:\d+)", video)
    rotation_match = re.search(r"rotation of\s+(-?[\d.]+)\s*degrees", text, re.I)
    color_values: list[str] = []
    for group in re.findall(r"\(([^)]*)\)", video):
        for value in re.split(r"[/,\s]+", group.lower()):
            if value in {"bt2020", "bt2020nc", "bt2020ncl", "smpte2084", "arib-std-b67", "bt709", "smpte170m", "pc", "tv"}:
                color_values.append(value)
    transfer = next((value for value in color_values if value in {"smpte2084", "arib-std-b67", "bt709", "smpte170m"}), "unknown")
    primaries = next((value for value in color_values if value in {"bt2020", "bt709"}), "unknown")
    matrix = next((value for value in color_values if value in {"bt2020nc", "bt2020ncl", "bt709", "smpte170m"}), "unknown")
    color_range = next((value for value in color_values if value in {"pc", "tv"}), "unknown")
    hdr_kind = "HDR10" if transfer == "smpte2084" else "HLG" if transfer == "arib-std-b67" else "SDR"
    dynamic_hdr = "Dolby Vision" if re.search(r"(?:DOVI|Dolby Vision|dvhe\.|dvh1\.)", text, re.I) else "HDR10+" if re.search(r"(?:HDR10\+|SMPTE\s*2094-40|dynamic HDR plus)", text, re.I) else ""
    mastering_match = re.search(r"Mastering Display Metadata[^\n]*(?:\n\s*[^\n]+)?", text, re.I)
    content_light_match = re.search(r"Content Light Level Metadata[^\n]*(?:\n\s*[^\n]+)?", text, re.I)
    bitrate_matches = re.findall(r"(\d+)\s*kb/s", video)
    video_bitrate = int(bitrate_matches[-1]) if bitrate_matches else 0
    return {
        "path": input_path,
        "name": os.path.basename(input_path),
        "duration": round(duration, 3),
        "sizeBytes": os.path.getsize(input_path) if os.path.isfile(input_path) else 0,
        "containerBitrateKbps": int(container_bitrate_match.group(1)) if container_bitrate_match else 0,
        "videoBitrateKbps": video_bitrate,
        "codec": codec,
        "profile": profile,
        "pixelFormat": pixel_format,
        "bitDepth": bit_depth,
        "width": width,
        "height": height,
        "frameRate": round(fps, 3),
        "sar": sar_match.group(1) if sar_match else "unknown",
        "dar": dar_match.group(1) if dar_match else "unknown",
        "rotation": round(float(rotation_match.group(1))) if rotation_match else 0,
        "transfer": transfer,
        "primaries": primaries,
        "matrix": matrix,
        "range": color_range,
        "hdr": hdr_kind != "SDR",
        "hdrKind": hdr_kind,
        "dynamicHdr": dynamic_hdr,
        "masteringDisplay": mastering_match.group(0).strip() if mastering_match else "",
        "contentLightLevel": content_light_match.group(0).strip() if content_light_match else "",
        "audioTracks": len(audio_lines),
        "subtitleTracks": len(subtitle_lines),
    }


@functools.lru_cache(maxsize=4)
def available_transcode_capabilities(ffmpeg_exe: str) -> dict:
    def output_for(*arguments: str) -> str:
        try:
            result = subprocess.run(
                [ffmpeg_exe, "-hide_banner", *arguments], stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                timeout=20, check=False,
            )
            return result.stdout or ""
        except (OSError, subprocess.SubprocessError):
            return ""

    encoders_text = output_for("-encoders")
    filters_text = output_for("-filters")
    encoder_names = {
        match.group(1) for match in re.finditer(r"(?m)^\s*V\S*\s+([\w-]+)\s", encoders_text)
    }
    relevant = (
        *GPU_VIDEO_ENCODERS, *H265_GPU_VIDEO_ENCODERS, *AV1_GPU_VIDEO_ENCODERS,
        SOFTWARE_VIDEO_ENCODER, SOFTWARE_H265_VIDEO_ENCODER, PRORES_VIDEO_ENCODER,
    )
    pixel_formats = {}
    for encoder_name in relevant:
        if encoder_name not in encoder_names:
            continue
        help_text = output_for("-h", f"encoder={encoder_name}")
        match = re.search(r"Supported pixel formats:\s*(.+)", help_text)
        pixel_formats[encoder_name] = match.group(1).split() if match else []
    usable_hardware: list[str] = []
    usable_hardware_10bit: list[str] = []
    for encoder_name in sorted(encoder_names.intersection(ALL_GPU_VIDEO_ENCODERS)):
        try:
            probe = subprocess.run(
                [ffmpeg_exe, "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=size=256x256:rate=1:duration=1",
                 "-frames:v", "1", "-an", "-c:v", encoder_name, "-pix_fmt", "yuv420p", "-f", "null", "-"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False,
            )
            if probe.returncode == 0:
                usable_hardware.append(encoder_name)
            if {"p010le", "yuv420p10le"}.intersection(pixel_formats.get(encoder_name, [])):
                probe_10bit = subprocess.run(
                    [ffmpeg_exe, "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=size=256x256:rate=1:duration=1",
                     "-frames:v", "1", "-an", "-vf", "format=p010le", "-c:v", encoder_name,
                     "-pix_fmt", "p010le", "-f", "null", "-"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False,
                )
                if probe_10bit.returncode == 0:
                    usable_hardware_10bit.append(encoder_name)
        except (OSError, subprocess.SubprocessError):
            continue
    filter_names = {
        match.group(1) for match in re.finditer(r"(?m)^\s*[\.A-Z|]{3,4}\s+([\w-]+)\s", filters_text)
    }
    return {
        "encoders": sorted(encoder_names.intersection(relevant)),
        "usableHardwareEncoders": usable_hardware,
        "usableHardware10BitEncoders": usable_hardware_10bit,
        "pixelFormats": pixel_formats,
        "filters": sorted(filter_names.intersection({"zscale", "tonemap", "subtitles", "loudnorm"})),
        "hdrToneMap": "zscale" in filter_names and "tonemap" in filter_names,
        "subtitleBurn": "subtitles" in filter_names,
        "av1Hardware": any(value in usable_hardware for value in AV1_GPU_VIDEO_ENCODERS),
        "hevc10Bit": SOFTWARE_H265_VIDEO_ENCODER in encoder_names and bool({"p010le", "yuv420p10le"}.intersection(pixel_formats.get(SOFTWARE_H265_VIDEO_ENCODER, [])))
        or any(value in usable_hardware_10bit for value in H265_GPU_VIDEO_ENCODERS),
    }


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


def general_transcode_encoder_candidates(
    ffmpeg_exe: str, video_mode: str, bit_depth: str = "8",
) -> list[str]:
    if video_mode == "copy":
        return ["copy"]
    capabilities = available_transcode_capabilities(ffmpeg_exe)
    available = set(capabilities["encoders"])
    pixel_formats = capabilities["pixelFormats"]
    if video_mode == "h265":
        candidates = [encoder for encoder in H265_GPU_VIDEO_ENCODERS if encoder in available]
        if SOFTWARE_H265_VIDEO_ENCODER in available:
            candidates.append(SOFTWARE_H265_VIDEO_ENCODER)
        if bit_depth == "10":
            candidates = [
                encoder for encoder in candidates
                if {"p010le", "yuv420p10le"}.intersection(pixel_formats.get(encoder, []))
            ]
        return candidates
    if video_mode == "av1":
        usable = set(capabilities.get("usableHardwareEncoders", []))
        return [encoder for encoder in AV1_GPU_VIDEO_ENCODERS if encoder in available and encoder in usable]
    if video_mode == "prores":
        return [PRORES_VIDEO_ENCODER] if PRORES_VIDEO_ENCODER in available else []
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
    subtitle_mode: str = "copy",
    color_mode: str = "auto",
    bit_depth: str = "auto",
    frame_rate_mode: str = "preserve",
    rotation: str = "auto",
    aspect_mode: str = "preserve",
    audio_track: str = "all",
    video_bitrate_mbps: float | None = None,
    audio_bitrate_kbps: int = 192,
) -> None:
    if container not in GENERAL_TRANSCODE_CONTAINERS:
        raise ValueError("不支持的输出封装")
    if video_mode not in {"copy", "h264", "h265", "av1", "prores"}:
        raise ValueError("不支持的视频编码模式")
    if quality not in GENERAL_TRANSCODE_QUALITY:
        raise ValueError("不支持的画质预设")
    if resolution not in GENERAL_TRANSCODE_LONG_EDGE:
        raise ValueError("不支持的输出分辨率")
    if frame_rate not in GENERAL_TRANSCODE_FRAME_RATES:
        raise ValueError("不支持的输出帧率")
    if audio_mode not in GENERAL_TRANSCODE_AUDIO:
        raise ValueError("不支持的音频处理方式")
    if subtitle_mode not in GENERAL_TRANSCODE_SUBTITLES:
        raise ValueError("不支持的字幕处理方式")
    if color_mode not in GENERAL_TRANSCODE_COLOR_MODES:
        raise ValueError("不支持的色彩处理方式")
    if bit_depth not in GENERAL_TRANSCODE_BIT_DEPTHS:
        raise ValueError("不支持的输出位深")
    if frame_rate_mode not in GENERAL_TRANSCODE_FRAME_RATE_MODES:
        raise ValueError("不支持的帧率模式")
    if rotation not in GENERAL_TRANSCODE_ROTATIONS:
        raise ValueError("不支持的旋转方式")
    if aspect_mode not in GENERAL_TRANSCODE_ASPECT_MODES:
        raise ValueError("不支持的像素宽高比模式")
    if audio_track not in GENERAL_TRANSCODE_AUDIO_TRACKS:
        raise ValueError("不支持的音轨选择")
    if video_bitrate_mbps is not None and not 0.1 <= video_bitrate_mbps <= 800:
        raise ValueError("视频码率必须在 0.1–800 Mbps 之间")
    if audio_bitrate_kbps not in {96, 128, 160, 192, 256, 320}:
        raise ValueError("不支持的 AAC 音频码率")
    if output_mode not in {"new", "replace", "delete-original"}:
        raise ValueError("不支持的输出方式")
    if video_mode == "copy" and (
        resolution != "original" or frame_rate != "original" or color_mode not in {"auto", "sdr"}
        or bit_depth not in {"auto", "8"} or rotation != "auto" or aspect_mode != "preserve"
        or subtitle_mode == "burn"
    ):
        raise ValueError("只更换封装时不能调整分辨率或帧率、画面、色彩、位深或烧录字幕")
    if color_mode in {"hdr10", "hlg"} and video_mode not in {"h265", "av1", "prores"}:
        raise ValueError("HDR10/HLG 输出需要 H.265、AV1 或 ProRes")
    if bit_depth == "10" and video_mode == "h264":
        raise ValueError("H.264 10-bit 兼容性过低，请选择 H.265、AV1 或 ProRes")
    if video_mode == "prores" and container != "mov":
        raise ValueError("ProRes 输出必须使用 MOV 封装")
    if video_mode == "av1" and container == "mov":
        raise ValueError("AV1 输出请使用 MP4 或 MKV 封装")


def _escape_subtitle_filter_path(path_value: str) -> str:
    return path_value.replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


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
    subtitle_mode: str = "copy",
    color_mode: str = "sdr",
    bit_depth: str = "8",
    frame_rate_mode: str = "preserve",
    rotation: str = "auto",
    aspect_mode: str = "preserve",
    audio_track: str = "all",
    video_bitrate_mbps: float | None = None,
    audio_bitrate_kbps: int = 192,
    encoder_preset: str = "balanced",
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
        subtitle_mode=subtitle_mode, color_mode=color_mode, bit_depth=bit_depth,
        frame_rate_mode=frame_rate_mode, rotation=rotation, aspect_mode=aspect_mode,
        audio_track=audio_track, video_bitrate_mbps=video_bitrate_mbps,
        audio_bitrate_kbps=audio_bitrate_kbps,
    )
    command = [
        ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        *(["-noautorotate"] if rotation != "auto" else []),
        "-i", input_path,
        "-map", "0:v:0", "-map", "0:a?" if audio_track == "all" else "0:a:0?",
        "-map_metadata", "0", "-map_chapters", "0",
    ]
    if subtitle_mode == "copy":
        command.extend(["-map", "0:s?"])
    if video_mode == "copy":
        command.extend(["-c:v", "copy"])
    else:
        filters: list[str] = []
        if aspect_mode == "square-pixels":
            filters.append("scale=trunc(iw*sar/2)*2:ih")
            filters.append("setsar=1")
        long_edge = GENERAL_TRANSCODE_LONG_EDGE[resolution]
        if long_edge:
            filters.append(
                f"scale='min({long_edge},iw)':'min({long_edge},ih)'"
                ":force_original_aspect_ratio=decrease:force_divisible_by=2"
            )
        else:
            filters.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")
        target_frame_rate = GENERAL_TRANSCODE_FRAME_RATES[frame_rate]
        if target_frame_rate and frame_rate_mode in {"preserve", "cfr"}:
            filters.append(f"fps={target_frame_rate}")
        if rotation == "90":
            filters.append("transpose=clock")
        elif rotation == "180":
            filters.extend(["hflip", "vflip"])
        elif rotation == "270":
            filters.append("transpose=cclock")
        if subtitle_mode == "burn":
            filters.append(f"subtitles='{_escape_subtitle_filter_path(input_path)}':si=0")
        output_bit_depth = "10" if color_mode in {"hdr10", "hlg"} or video_mode == "prores" else bit_depth
        if color_mode == "hdr-to-sdr":
            filters.extend([
                "zscale=t=linear:npl=100", "format=gbrpf32le",
                "zscale=p=bt709", "tonemap=tonemap=hable:desat=2",
                "zscale=t=bt709:m=bt709:r=tv", "format=yuv420p",
            ])
            output_bit_depth = "8"
        if video_mode == "h265":
            allowed_encoders = (*H265_GPU_VIDEO_ENCODERS, SOFTWARE_H265_VIDEO_ENCODER)
            selected_encoder = encoder if encoder in allowed_encoders else SOFTWARE_H265_VIDEO_ENCODER
            quality_value = GENERAL_TRANSCODE_H265_QUALITY[quality]
        elif video_mode == "av1":
            allowed_encoders = AV1_GPU_VIDEO_ENCODERS
            selected_encoder = encoder if encoder in allowed_encoders else AV1_GPU_VIDEO_ENCODERS[0]
            quality_value = GENERAL_TRANSCODE_AV1_QUALITY[quality]
        elif video_mode == "prores":
            selected_encoder = PRORES_VIDEO_ENCODER
            quality_value = GENERAL_TRANSCODE_QUALITY[quality]
        else:
            allowed_encoders = (*GPU_VIDEO_ENCODERS, SOFTWARE_VIDEO_ENCODER)
            selected_encoder = encoder if encoder in allowed_encoders else SOFTWARE_VIDEO_ENCODER
            quality_value = GENERAL_TRANSCODE_QUALITY[quality]
        software_preset = {"fast": "fast", "balanced": "medium", "quality": "slow"}.get(encoder_preset, "medium")
        nvenc_preset = {"fast": "p2", "balanced": "p4", "quality": "p6"}.get(encoder_preset, "p4")
        encoder_options = {
            "h264_nvenc": [
                "-c:v", "h264_nvenc", "-preset", nvenc_preset, "-tune", "hq",
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
                "-c:v", SOFTWARE_VIDEO_ENCODER, "-preset", software_preset,
                "-crf", str(quality_value),
            ],
            "hevc_nvenc": [
                "-c:v", "hevc_nvenc", "-preset", nvenc_preset, "-tune", "hq",
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
                "-c:v", SOFTWARE_H265_VIDEO_ENCODER, "-preset", software_preset,
                "-crf", str(quality_value),
                *(["-x265-params", "hdr10-opt=1:repeat-headers=1"] if color_mode == "hdr10" else []),
            ],
            "av1_nvenc": [
                "-c:v", "av1_nvenc", "-preset", nvenc_preset, "-tune", "hq",
                "-rc", "vbr", "-cq", str(quality_value), "-b:v", "0",
            ],
            "av1_qsv": ["-c:v", "av1_qsv", "-global_quality", str(quality_value)],
            "av1_amf": ["-c:v", "av1_amf", "-quality", "quality", "-qp_i", str(quality_value)],
            PRORES_VIDEO_ENCODER: [
                "-c:v", PRORES_VIDEO_ENCODER,
                "-profile:v", str({"high": 4, "balanced": 3, "small": 2}[quality]),
                "-vendor", "apl0", "-bits_per_mb", "8000",
            ],
        }[selected_encoder]
        pixel_format = "yuv422p10le" if video_mode == "prores" else "p010le" if output_bit_depth == "10" and selected_encoder in ALL_GPU_VIDEO_ENCODERS else "yuv420p10le" if output_bit_depth == "10" else "yuv420p"
        command.extend([
            "-vf", ",".join(filters),
            *encoder_options,
            "-pix_fmt", pixel_format,
            "-metadata:s:v:0", "rotate=0",
        ])
        if video_bitrate_mbps is not None:
            bitrate = f"{video_bitrate_mbps:g}M"
            command.extend(["-b:v", bitrate, "-maxrate", bitrate, "-bufsize", f"{video_bitrate_mbps * 2:g}M"])
        if color_mode == "hdr10":
            command.extend(["-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv"])
        elif color_mode == "hlg":
            command.extend(["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-color_range", "tv"])
        else:
            command.extend(["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"])
    if audio_mode == "remove":
        command.append("-an")
    elif audio_mode == "aac":
        command.extend(["-c:a", "aac", "-b:a", f"{audio_bitrate_kbps}k"])
    else:
        command.extend(["-c:a", "copy"])
    if subtitle_mode == "copy":
        command.extend(["-c:s", "copy"])
    elif subtitle_mode == "remove" or subtitle_mode == "burn":
        command.append("-sn")
    if container in {"mp4", "mov"}:
        if video_mode == "h265":
            command.extend(["-tag:v", "hvc1"])
        command.extend(["-movflags", "+faststart"])
    if video_mode != "copy":
        command.extend(["-fps_mode", "vfr" if frame_rate_mode == "vfr" else "cfr" if frame_rate_mode == "cfr" else "passthrough"])
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
    subtitle_mode: str = "copy",
    color_mode: str = "auto",
    bit_depth: str = "auto",
    frame_rate_mode: str = "preserve",
    rotation: str = "auto",
    aspect_mode: str = "preserve",
    audio_track: str = "all",
    video_bitrate_mbps: float | None = None,
    audio_bitrate_kbps: int = 192,
    encoder_preset: str = "balanced",
    output_mode: str = "new",
    destination_directory: str | None = None,
    on_progress: Callable[[float], None] | None = None,
    on_log: Callable[[str], None] | None = None,
    cancel_check: Callable[[], None] | None = None,
    pause_check: Callable[[], bool] | None = None,
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
        subtitle_mode=subtitle_mode, color_mode=color_mode, bit_depth=bit_depth,
        frame_rate_mode=frame_rate_mode, rotation=rotation, aspect_mode=aspect_mode,
        audio_track=audio_track, video_bitrate_mbps=video_bitrate_mbps,
        audio_bitrate_kbps=audio_bitrate_kbps,
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
    replaces_same_path = output_mode in {"replace", "delete-original"} and not destination_directory and source_extension == output_extension
    destination = input_path if replaces_same_path else _unique_transcode_output(
        input_path, container, destination_directory,
        add_transcode_suffix=output_mode == "new" and not destination_directory,
    )
    temporary = os.path.join(
        os.path.dirname(destination),
        f".{os.path.splitext(os.path.basename(destination))[0]}.{uuid.uuid4().hex}.photoflow-transcode{output_extension}",
    )
    duration = probe_duration(input_path)
    try:
        source_info = probe_media_info(input_path)
    except Exception:
        source_info = {"hdr": False, "hdrKind": "SDR", "bitDepth": 8}
    resolved_color_mode = color_mode
    if color_mode == "auto":
        if source_info.get("dynamicHdr") and video_mode != "copy":
            raise FFmpegTranscodeError(f"暂不安全转码 {source_info['dynamicHdr']} 动态元数据；请选择仅更换封装，或明确转为 HDR10/SDR")
        if source_info.get("hdr"):
            resolved_color_mode = (
                str(source_info.get("hdrKind", "")).lower()
                if video_mode in {"h265", "av1", "prores", "copy"}
                else "hdr-to-sdr"
            )
        else:
            resolved_color_mode = "sdr"
    if video_mode == "copy":
        resolved_color_mode = "auto"
    elif resolved_color_mode == "hdr-to-sdr" and not source_info.get("hdr"):
        raise FFmpegTranscodeError("来源不是 HDR 视频，不需要执行 HDR→SDR 色调映射")
    if source_info.get("hdr") and resolved_color_mode == "sdr":
        raise FFmpegTranscodeError("HDR 来源不能仅改写为 SDR 标记；请选择“HDR 转 SDR”执行色调映射")
    if resolved_color_mode == "hdr10" and source_info.get("transfer") != "smpte2084":
        raise FFmpegTranscodeError("来源不是 HDR10/PQ，不能只改写为 HDR10；请选择自动保留或 HDR 转 SDR")
    if resolved_color_mode == "hlg" and source_info.get("transfer") != "arib-std-b67":
        raise FFmpegTranscodeError("来源不是 HLG，不能只改写为 HLG；请选择自动保留或 HDR 转 SDR")
    resolved_bit_depth = bit_depth
    if bit_depth == "auto":
        resolved_bit_depth = "10" if int(source_info.get("bitDepth", 8) or 8) > 8 and video_mode in {"h265", "av1", "prores"} else "8"
    if resolved_color_mode in {"hdr10", "hlg"}:
        resolved_bit_depth = "10"
    if video_mode == "copy":
        resolved_bit_depth = "auto"
    validate_general_transcode_options(
        container=container, video_mode=video_mode, quality=quality,
        resolution=resolution, frame_rate=frame_rate, audio_mode=audio_mode,
        output_mode=output_mode, subtitle_mode=subtitle_mode,
        color_mode=resolved_color_mode, bit_depth=resolved_bit_depth,
        frame_rate_mode=frame_rate_mode, rotation=rotation, aspect_mode=aspect_mode,
        audio_track=audio_track, video_bitrate_mbps=video_bitrate_mbps,
        audio_bitrate_kbps=audio_bitrate_kbps,
    )
    ffmpeg_exe = get_ffmpeg_exe()
    capabilities = available_transcode_capabilities(ffmpeg_exe)
    if resolved_color_mode == "hdr-to-sdr" and not capabilities["hdrToneMap"]:
        raise FFmpegTranscodeError("当前媒体运行库缺少 HDR→SDR 色调映射滤镜，请重新安装或更新运行库")
    if subtitle_mode == "burn" and not capabilities["subtitleBurn"]:
        raise FFmpegTranscodeError("当前媒体运行库缺少字幕烧录滤镜，请重新安装或更新运行库")
    encoder_candidates = general_transcode_encoder_candidates(ffmpeg_exe, video_mode, resolved_bit_depth)
    if not encoder_candidates:
        if video_mode == "av1":
            raise FFmpegTranscodeError("未检测到支持 AV1 编码的显卡；AV1 Lite 模式需要 NVIDIA、Intel 或 AMD 的兼容硬件")
        if resolved_bit_depth == "10":
            raise FFmpegTranscodeError("没有可用的 10-bit 编码器；请更新显卡驱动或安装含 x265 10-bit 的媒体运行库")
        raise FFmpegTranscodeError(f"当前媒体运行库没有可用的 {video_mode} 编码器")
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
                encoder=encoder, subtitle_mode=subtitle_mode,
                color_mode=resolved_color_mode, bit_depth=resolved_bit_depth,
                frame_rate_mode=frame_rate_mode, rotation=rotation,
                aspect_mode=aspect_mode, audio_track=audio_track,
                video_bitrate_mbps=video_bitrate_mbps,
                audio_bitrate_kbps=audio_bitrate_kbps, encoder_preset=encoder_preset,
            )
            attempt_arguments = (command, duration, on_progress, cancel_check)
            code, stderr = _run_general_transcode_attempt(
                *attempt_arguments, **({"pause_check": pause_check} if pause_check is not None else {}),
            )
            if code == 0 and os.path.isfile(temporary) and os.path.getsize(temporary) > 0:
                try:
                    try:
                        output_info = probe_media_info(temporary)
                        output_duration = float(output_info.get("duration", 0))
                    except (FFmpegTranscodeError, OSError, subprocess.SubprocessError):
                        output_duration = probe_duration(temporary)
                        output_info = {
                            "duration": output_duration, "codec": {"h265": "hevc"}.get(video_mode, video_mode),
                            "pixelFormat": "yuv420p10le" if resolved_bit_depth == "10" else "yuv420p",
                            "bitDepth": int(resolved_bit_depth), "width": 0, "height": 0,
                            "hdrKind": resolved_color_mode.upper() if resolved_color_mode in {"hdr10", "hlg"} else "SDR",
                            "transfer": {"hdr10": "smpte2084", "hlg": "arib-std-b67"}.get(resolved_color_mode, "bt709"),
                        }
                    if output_duration <= 0 or abs(output_duration - duration) > max(2.0, duration * .05):
                        raise FFmpegTranscodeError("转码结果时长校验失败")
                    if resolved_bit_depth == "10" and int(output_info.get("bitDepth", 0)) < 10:
                        raise FFmpegTranscodeError("转码结果位深校验失败：预期 10-bit")
                    expected_transfer = {"hdr10": "smpte2084", "hlg": "arib-std-b67"}.get(resolved_color_mode)
                    if expected_transfer and output_info.get("transfer") != expected_transfer:
                        raise FFmpegTranscodeError("转码结果 HDR 色彩标记校验失败")
                    if resolved_color_mode == "hdr10" and source_info.get("masteringDisplay") and not output_info.get("masteringDisplay"):
                        raise FFmpegTranscodeError("转码结果丢失 HDR10 Mastering Display 元数据")
                    if resolved_color_mode == "hdr10" and source_info.get("contentLightLevel") and not output_info.get("contentLightLevel"):
                        raise FFmpegTranscodeError("转码结果丢失 HDR10 Content Light Level 元数据")
                    expected_codec = {"h264": "h264", "h265": "hevc", "av1": "av1", "prores": "prores"}.get(video_mode)
                    if expected_codec and output_info.get("codec") not in {expected_codec, "unknown"}:
                        raise FFmpegTranscodeError(f"转码结果编码校验失败：预期 {expected_codec}")
                    long_edge_limit = GENERAL_TRANSCODE_LONG_EDGE.get(resolution)
                    output_width = int(output_info.get("width", 0) or 0)
                    output_height = int(output_info.get("height", 0) or 0)
                    if long_edge_limit and max(output_width, output_height) > long_edge_limit + 2:
                        raise FFmpegTranscodeError("转码结果分辨率校验失败")
                    target_fps = GENERAL_TRANSCODE_FRAME_RATES.get(frame_rate)
                    output_fps = float(output_info.get("frameRate", 0) or 0)
                    if frame_rate_mode == "cfr" and target_fps and output_fps and abs(output_fps - target_fps) > .02:
                        raise FFmpegTranscodeError("转码结果固定帧率校验失败")
                    if aspect_mode == "square-pixels" and output_info.get("sar") not in {None, "unknown", "1:1"}:
                        raise FFmpegTranscodeError("转码结果像素宽高比校验失败")
                    if rotation != "auto" and output_info.get("rotation") not in {None, 0}:
                        raise FFmpegTranscodeError("转码结果旋转元数据校验失败")
                    if audio_mode == "remove" and int(output_info.get("audioTracks", 0) or 0) != 0:
                        raise FFmpegTranscodeError("转码结果仍包含音轨")
                    if audio_track == "first" and int(output_info.get("audioTracks", 0) or 0) > 1:
                        raise FFmpegTranscodeError("转码结果音轨选择校验失败")
                    if subtitle_mode in {"remove", "burn"} and int(output_info.get("subtitleTracks", 0) or 0) != 0:
                        raise FFmpegTranscodeError("转码结果字幕轨处理校验失败")
                except (FFmpegTranscodeError, OSError) as error:
                    last_detail = str(error)
                else:
                    if cancel_check:
                        cancel_check()
                    if output_mode == "delete-original" and os.path.normcase(destination) == os.path.normcase(input_path):
                        send2trash(input_path)
                        try:
                            # Once the original is in the recycle bin, finish the
                            # commit even if cancellation is requested in this
                            # very small window; abandoning it would lose the
                            # verified replacement from the working folder.
                            _retry_windows_sharing_violation(lambda: os.replace(temporary, destination))
                        except OSError:
                            recovery_output = _unique_transcode_output(input_path, container, add_transcode_suffix=True)
                            _retry_windows_sharing_violation(lambda: os.replace(temporary, recovery_output))
                            destination = recovery_output
                            if on_log:
                                on_log(f"原视频已移入回收站；新视频无法使用原文件名，已另存为：{recovery_output}")
                    else:
                        _retry_windows_sharing_violation(lambda: os.replace(temporary, destination), cancel_check)
                        if output_mode == "delete-original":
                            try:
                                send2trash(input_path)
                            except Exception as recycle_error:
                                try:
                                    _retry_windows_sharing_violation(lambda: os.remove(destination), cancel_check)
                                except OSError:
                                    pass
                                raise FFmpegTranscodeError("无法将原视频移入回收站，已保留原视频") from recycle_error
                    if on_progress:
                        on_progress(100.0)
                    if on_log and encoder != "copy":
                        backend = "GPU" if encoder in ALL_GPU_VIDEO_ENCODERS else "CPU"
                        on_log(f"视频编码器：{encoder}（{backend}）")
                        on_log(
                            f"技术校验通过：{output_info.get('codec')} · {output_info.get('pixelFormat')} · "
                            f"{output_info.get('width')}×{output_info.get('height')} · {output_info.get('hdrKind')}"
                        )
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
    pause_check: Callable[[], bool] | None = None,
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
    process_paused = False

    def set_process_paused(paused: bool) -> None:
        nonlocal process_paused
        if paused == process_paused or process.poll() is not None:
            return
        if sys.platform.startswith("win"):
            import ctypes
            access = 0x0800
            handle = ctypes.windll.kernel32.OpenProcess(access, False, process.pid)
            if not handle:
                raise OSError("无法控制编码进程暂停状态")
            try:
                ntdll = ctypes.windll.ntdll
                status = (ntdll.NtSuspendProcess if paused else ntdll.NtResumeProcess)(handle)
                if status != 0:
                    raise OSError(f"编码进程暂停控制失败：{status}")
            finally:
                ctypes.windll.kernel32.CloseHandle(handle)
        else:
            os.kill(process.pid, signal.SIGSTOP if paused else signal.SIGCONT)
        process_paused = paused

    def watch_cancellation():
        while not watcher_done.wait(.2) and process.poll() is None:
            try:
                if cancel_check is not None:
                    cancel_check()
                set_process_paused(bool(pause_check and pause_check()))
            except BaseException as error:
                cancellation_errors.append(error)
                try:
                    set_process_paused(False)
                except OSError:
                    pass
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
        if process_paused:
            try:
                set_process_paused(False)
            except OSError:
                pass
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


def estimate_transcode_size_bytes(media: dict, settings: dict) -> int:
    """Return a transparent planning estimate, never a promised output size."""
    duration = max(0.0, float(media.get("duration", 0) or 0))
    if settings.get("video_mode") == "copy":
        return int(media.get("sizeBytes", 0) or 0)
    custom_rate = settings.get("video_bitrate_mbps")
    if custom_rate:
        video_mbps = float(custom_rate)
    else:
        width = max(1, int(media.get("width", 1920) or 1920))
        height = max(1, int(media.get("height", 1080) or 1080))
        fps = max(1.0, float(media.get("frameRate", 30) or 30))
        target_long_edge = GENERAL_TRANSCODE_LONG_EDGE.get(settings.get("resolution"))
        if target_long_edge and max(width, height) > target_long_edge:
            dimension_scale = target_long_edge / max(width, height)
            width = round(width * dimension_scale)
            height = round(height * dimension_scale)
        if settings.get("frame_rate_mode") == "cfr" and GENERAL_TRANSCODE_FRAME_RATES.get(settings.get("frame_rate")):
            fps = float(GENERAL_TRANSCODE_FRAME_RATES[settings["frame_rate"]])
        scale = width * height * fps / (1920 * 1080 * 30)
        quality_factor = {"high": 10.0, "balanced": 6.0, "small": 3.5}.get(settings.get("quality"), 6.0)
        codec_factor = {"h264": 1.0, "h265": .62, "av1": .52, "prores": 24.0}.get(settings.get("video_mode"), 1.0)
        video_mbps = max(.5, quality_factor * codec_factor * scale)
    audio_mbps = 0.0
    if settings.get("audio_mode") == "aac":
        audio_mbps = int(settings.get("audio_bitrate_kbps", 192)) / 1000
    elif settings.get("audio_mode") == "copy":
        audio_mbps = .256 * max(1, int(media.get("audioTracks", 1) or 1))
    return round(duration * (video_mbps + audio_mbps) * 1_000_000 / 8 * 1.015)


def run(args_list=None) -> int:
    parser = argparse.ArgumentParser(description="PhotoFlow general video transcoder")
    parser.add_argument("paths", nargs="*", help="输入视频路径")
    parser.add_argument("--container", choices=sorted(GENERAL_TRANSCODE_CONTAINERS), default="mp4")
    parser.add_argument("--video-mode", choices=("h264", "h265", "av1", "prores", "copy"), default="h264")
    parser.add_argument("--quality", choices=sorted(GENERAL_TRANSCODE_QUALITY), default="balanced")
    parser.add_argument("--resolution", choices=tuple(GENERAL_TRANSCODE_LONG_EDGE), default="original")
    parser.add_argument("--frame-rate", choices=tuple(GENERAL_TRANSCODE_FRAME_RATES), default="original")
    parser.add_argument("--audio-mode", choices=sorted(GENERAL_TRANSCODE_AUDIO), default="aac")
    parser.add_argument("--subtitle-mode", choices=sorted(GENERAL_TRANSCODE_SUBTITLES), default="copy")
    parser.add_argument("--color-mode", choices=sorted(GENERAL_TRANSCODE_COLOR_MODES), default="auto")
    parser.add_argument("--bit-depth", choices=sorted(GENERAL_TRANSCODE_BIT_DEPTHS), default="auto")
    parser.add_argument("--frame-rate-mode", choices=sorted(GENERAL_TRANSCODE_FRAME_RATE_MODES), default="preserve")
    parser.add_argument("--rotation", choices=sorted(GENERAL_TRANSCODE_ROTATIONS), default="auto")
    parser.add_argument("--aspect-mode", choices=sorted(GENERAL_TRANSCODE_ASPECT_MODES), default="preserve")
    parser.add_argument("--audio-track", choices=sorted(GENERAL_TRANSCODE_AUDIO_TRACKS), default="all")
    parser.add_argument("--video-bitrate-mbps", type=float, default=None)
    parser.add_argument("--audio-bitrate-kbps", type=int, default=192)
    parser.add_argument("--encoder-preset", choices=("fast", "balanced", "quality"), default="balanced")
    parser.add_argument("--retry-count", type=int, choices=range(0, 4), default=1)
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--output-mode", choices=("new", "replace", "delete-original"), default="new")
    parser.add_argument("--source-folder", action="append", default=[], help="所选来源文件夹；输出到其同级转码目录")
    parser.add_argument("--cancel_file", default="")
    parser.add_argument("--pause_file", default="")
    args = parser.parse_args(args_list)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    raw_paths = list(dict.fromkeys(os.path.abspath(value.strip('"').strip("'")) for value in args.paths))
    source_folders = list(dict.fromkeys(os.path.abspath(value) for value in args.source_folder))
    missing_paths: list[str] = []
    paths: list[str] = []
    for raw_path in raw_paths:
        if os.path.isfile(raw_path):
            paths.append(raw_path)
            continue
        if os.path.isdir(raw_path):
            source_folders.append(raw_path)
            for directory, directory_names, file_names in os.walk(raw_path):
                directory_names.sort(key=str.casefold)
                for file_name in sorted(file_names, key=str.casefold):
                    candidate = os.path.join(directory, file_name)
                    if os.path.splitext(candidate)[1].lower() in GENERAL_TRANSCODE_INPUT_EXTENSIONS:
                        paths.append(candidate)
            continue
        missing_paths.append(raw_path)
    paths = list(dict.fromkeys(paths))
    source_folders = list(dict.fromkeys(source_folders))
    cancel_file = os.path.abspath(args.cancel_file) if args.cancel_file else ""
    pause_file = os.path.abspath(args.pause_file) if args.pause_file else ""

    class TranscodeCancelled(RuntimeError):
        pass

    def check_cancelled() -> None:
        if cancel_file and os.path.exists(cancel_file):
            raise TranscodeCancelled("视频转码已取消")

    def check_paused() -> bool:
        return bool(pause_file and os.path.exists(pause_file))

    outputs: list[str] = []
    try:
        settings = {
            "container": args.container, "video_mode": args.video_mode, "quality": args.quality,
            "resolution": args.resolution, "frame_rate": args.frame_rate,
            "audio_mode": args.audio_mode, "subtitle_mode": args.subtitle_mode,
            "color_mode": args.color_mode, "bit_depth": args.bit_depth,
            "frame_rate_mode": args.frame_rate_mode, "rotation": args.rotation,
            "aspect_mode": args.aspect_mode, "audio_track": args.audio_track,
            "video_bitrate_mbps": args.video_bitrate_mbps,
            "audio_bitrate_kbps": args.audio_bitrate_kbps,
        }
        validate_general_transcode_options(
            container=args.container, video_mode=args.video_mode, quality=args.quality,
            resolution=args.resolution, frame_rate=args.frame_rate,
            audio_mode=args.audio_mode, output_mode=args.output_mode,
            subtitle_mode=args.subtitle_mode, color_mode=args.color_mode,
            bit_depth=args.bit_depth, frame_rate_mode=args.frame_rate_mode,
            rotation=args.rotation, aspect_mode=args.aspect_mode,
            audio_track=args.audio_track, video_bitrate_mbps=args.video_bitrate_mbps,
            audio_bitrate_kbps=args.audio_bitrate_kbps,
        )
        if missing_paths:
            raise FileNotFoundError(f"找不到输入路径：{missing_paths[0]}")
        if not paths and not args.inspect_only:
            raise ValueError("所选文件或文件夹中没有可转码的视频")
        capabilities = available_transcode_capabilities(get_ffmpeg_exe())
        if args.inspect_only:
            media_info = []
            total_estimated_bytes = 0
            for index, path in enumerate(paths):
                check_cancelled()
                _emit_cli("progress", f"正在分析：{os.path.basename(path)}（{index + 1}/{len(paths)}）", index / max(1, len(paths)) * 100)
                info = probe_media_info(path)
                info["estimatedOutputBytes"] = estimate_transcode_size_bytes(info, settings)
                total_estimated_bytes += info["estimatedOutputBytes"]
                media_info.append(info)
            _emit_cli(
                "success", f"媒体分析完成，共 {len(media_info)} 个视频", 100,
                mediaInfo=media_info, capabilities=capabilities,
                estimatedOutputBytes=total_estimated_bytes,
            )
            return 0
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
        failures: list[tuple[str, str]] = []
        for index, path in enumerate(paths):
            check_cancelled()
            pause_logged = False
            while check_paused():
                if not pause_logged:
                    _emit_cli("status", "队列已暂停；恢复后继续处理")
                    pause_logged = True
                time.sleep(.2)
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
            output = ""
            last_error: Exception | None = None
            for retry_index in range(args.retry_count + 1):
                try:
                    output = transcode_video(
                        path,
                        container=args.container, video_mode=args.video_mode,
                        quality=args.quality, resolution=args.resolution,
                        frame_rate=args.frame_rate, audio_mode=args.audio_mode,
                        subtitle_mode=args.subtitle_mode, color_mode=args.color_mode,
                        bit_depth=args.bit_depth, frame_rate_mode=args.frame_rate_mode,
                        rotation=args.rotation, aspect_mode=args.aspect_mode,
                        audio_track=args.audio_track,
                        video_bitrate_mbps=args.video_bitrate_mbps,
                        audio_bitrate_kbps=args.audio_bitrate_kbps,
                        encoder_preset=args.encoder_preset,
                        output_mode=args.output_mode,
                        destination_directory=destination_directories.get(path),
                        on_progress=emit_transcode_progress, on_log=emit_transcode_log,
                        cancel_check=check_cancelled, pause_check=check_paused,
                    )
                    break
                except TranscodeCancelled:
                    raise
                except Exception as error:
                    last_error = error
                    if retry_index < args.retry_count:
                        _emit_cli("warning", f"{name} 转码失败，正在重试（{retry_index + 1}/{args.retry_count}）：{error}")
            if not output:
                failures.append((path, str(last_error or "未知错误")))
                _emit_cli("warning", f"{name} 转码失败，原视频已保留：{last_error}")
                continue
            outputs.append(output)
            _emit_cli("log", f"已生成：{output}")
        if failures and not outputs:
            raise RuntimeError(f"全部 {len(failures)} 个视频转码失败，原视频均已保留")
        completed_message = f"视频转码完成，共处理 {len(outputs)} 个文件"
        if failures:
            completed_message += f"，失败 {len(failures)} 个（原视频已保留）"
        _emit_cli(
            "success",
            completed_message,
            100,
            outputs=outputs,
            failedCount=len(failures),
            failures=[{"path": path, "error": error} for path, error in failures],
            report=[probe_media_info(output) for output in outputs],
            folderOutputs=[
                {"sourceFolder": source_folder, "outputFolder": output_folder}
                for source_folder, output_folder in folder_destinations.items()
                if any(_path_is_inside(output, output_folder) for output in outputs)
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
        if pause_file:
            try:
                os.remove(pause_file)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
