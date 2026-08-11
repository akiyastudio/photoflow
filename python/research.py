import argparse
import ctypes
import os
import shutil
import sys
import unicodedata
from pathlib import Path

import cv2
import numpy as np
from event_protocol import log_error, log_info, log_progress, log_success, log_warning
from PIL import Image
from send2trash import send2trash


VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".m4v", ".webm"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
PREVIEW_WIDTH = 384
QUALITY_WIDTH = 640
MIN_FRAME_SHARPNESS = 24.0
BLACK_FRAME_LUMA_P99 = 18.0


def detected_video_container(file_path):
    """Identify supported video containers without trusting the file extension."""
    try:
        with open(file_path, "rb") as source:
            header = source.read(4096)
    except OSError:
        return None
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"AVI ":
        return "avi"
    if header.startswith(b"\x1aE\xdf\xa3"):
        return "matroska"
    if header.startswith(b"\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6c"):
        return "asf"
    # ISO BMFF files normally begin with an ftyp box, while older QuickTime MOV
    # files may begin directly with moov/mdat. Parse bounded top-level boxes so
    # random HTML/JavaScript containing one of those strings is not accepted.
    offset = 0
    while offset + 8 <= len(header):
        size = int.from_bytes(header[offset:offset + 4], "big")
        box_type = header[offset + 4:offset + 8]
        if box_type in {b"ftyp", b"moov", b"mdat", b"styp", b"moof"}:
            return "iso-bmff"
        if box_type not in {b"free", b"skip", b"wide", b"sidx"}:
            break
        if size == 1 and offset + 16 <= len(header):
            size = int.from_bytes(header[offset + 8:offset + 16], "big")
        if size < 8 or offset + size > len(header):
            break
        offset += size
    return None


def configure_text_streams():
    """Keep the JSON event stream UTF-8 on Windows, regardless of its code page."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="backslashreplace")


configure_text_streams()


def sanitize_filename(filename):
    """Return a Windows-safe name without discarding valid Unicode characters."""
    invalid_chars = r'\\/:*?"<>|'
    filename = unicodedata.normalize("NFC", str(filename))
    filename = "".join(
        "_" if char in invalid_chars or unicodedata.category(char) in {"Cc", "Cs"} else char
        for char in filename
    )
    # Windows silently rejects names ending in a space/dot and reserves these
    # device names even when an extension is present.
    filename = filename.strip().rstrip(" .")
    if not filename:
        return "未命名"
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if filename.split(".", 1)[0].upper() in reserved:
        filename = f"_{filename}"
    return filename


def windows_short_path(path):
    """Use an ASCII-compatible 8.3 path when a Windows OpenCV build needs it."""
    if os.name != "nt":
        return path
    try:
        get_short_path = ctypes.windll.kernel32.GetShortPathNameW
        get_short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        get_short_path.restype = ctypes.c_uint
        size = get_short_path(path, None, 0)
        if not size:
            return path
        buffer = ctypes.create_unicode_buffer(size)
        if not get_short_path(path, buffer, size):
            return path
        return buffer.value
    except (AttributeError, OSError, ValueError):
        return path


def open_video(video_path):
    """Open paths containing Chinese, emoji, and other Unicode characters."""
    candidates = []
    short_path = windows_short_path(os.path.abspath(video_path))
    if short_path != video_path:
        candidates.append(short_path)
    candidates.append(video_path)
    for candidate in dict.fromkeys(candidates):
        cap = cv2.VideoCapture(candidate, cv2.CAP_ANY)
        if cap.isOpened():
            return cap
        cap.release()
    return cv2.VideoCapture()


def preview_features(frame):
    """Return inexpensive features that are relatively robust to camera motion."""
    height, width = frame.shape[:2]
    if width > PREVIEW_WIDTH:
        frame = cv2.resize(frame, (PREVIEW_WIDTH, max(1, round(height * PREVIEW_WIDTH / width))))
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
    histogram = cv2.normalize(histogram, histogram).flatten()
    edges = cv2.Canny(gray, 80, 160)
    return gray, histogram, edges


def frame_difference(previous, current):
    previous_gray, previous_hist, previous_edges = previous
    current_gray, current_hist, current_edges = current

    colour = cv2.compareHist(previous_hist.astype(np.float32), current_hist.astype(np.float32), cv2.HISTCMP_BHATTACHARYYA)
    luminance = float(np.mean(cv2.absdiff(previous_gray, current_gray))) / 255.0

    # Dilating first tolerates a small camera pan while retaining the strong signal
    # caused by a real cut.
    kernel = np.ones((3, 3), np.uint8)
    old_edges = cv2.dilate(previous_edges, kernel)
    new_edges = cv2.dilate(current_edges, kernel)
    previous_count = max(1, int(np.count_nonzero(previous_edges)))
    current_count = max(1, int(np.count_nonzero(current_edges)))
    disappeared = np.count_nonzero((previous_edges > 0) & (new_edges == 0)) / previous_count
    appeared = np.count_nonzero((current_edges > 0) & (old_edges == 0)) / current_count
    edge_change = max(disappeared, appeared)
    return float(0.55 * colour + 0.25 * edge_change + 0.20 * luminance)


def normalize_sensitivity(sensitivity):
    if sensitivity in {"low", "standard", "high"}:
        return sensitivity
    # Compatibility for direct callers and old --threshold values.
    try:
        threshold = float(sensitivity)
        return "high" if threshold >= 0.98 else "low" if threshold <= 0.85 else "standard"
    except (TypeError, ValueError):
        return "standard"


def robust_thresholds(scores, sensitivity):
    values = np.asarray(scores, dtype=np.float32)
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median))) + 1e-6
    settings = {
        "low": (0.18, 0.985, 7.0, 0.06, 3.0),
        "standard": (0.12, 0.96, 5.0, 0.04, 2.2),
        "high": (0.08, 0.90, 3.5, 0.025, 1.5),
    }
    hard_floor, quantile, hard_mad, soft_floor, soft_mad = settings[normalize_sensitivity(sensitivity)]
    hard = max(hard_floor, float(np.quantile(values, quantile)), median + hard_mad * mad)
    soft = max(soft_floor, median + soft_mad * mad)
    return hard, min(soft, hard * 0.85)


def find_boundaries(scores, fps, sensitivity, min_duration):
    if not scores:
        return []
    sensitivity = normalize_sensitivity(sensitivity)
    hard, soft = robust_thresholds(scores, sensitivity)
    candidates = []
    prominence_floor = {"low": 0.08, "standard": 0.05, "high": 0.025}[sensitivity]

    # Sharp cuts are local maxima above the per-video adaptive threshold.
    for index, score in enumerate(scores):
        left = scores[index - 1] if index else -1.0
        right = scores[index + 1] if index + 1 < len(scores) else -1.0
        neighbours = scores[max(0, index - 5):index] + scores[index + 1:min(len(scores), index + 6)]
        local_baseline = float(np.median(neighbours)) if neighbours else 0.0
        if score >= hard and score - local_baseline >= prominence_floor and score >= left and score >= right:
            candidates.append((index + 1, score, "cut"))

    # A fade/dissolve yields a run of moderate change instead of one large peak.
    run_start = None
    max_index = -1
    max_score = -1.0
    max_gap = max(1, round(fps * 0.08))
    last_active = -1
    for index, score in enumerate(scores if sensitivity != "low" else []):
        if score >= soft:
            if run_start is None or index - last_active > max_gap:
                if run_start is not None and last_active - run_start + 1 >= max(3, round(fps * (0.12 if sensitivity == "high" else 0.22))):
                    candidates.append((max_index + 1, max_score, "gradual"))
                run_start, max_index, max_score = index, index, score
            elif score > max_score:
                max_index, max_score = index, score
            last_active = index
    if run_start is not None and last_active - run_start + 1 >= max(3, round(fps * (0.12 if sensitivity == "high" else 0.22))):
        candidates.append((max_index + 1, max_score, "gradual"))

    # Do not create unusably short shots.  For conflicting detections retain the
    # stronger one, which is normally the actual edit point.
    minimum_shot_seconds = {"low": 1.25, "standard": 0.65, "high": 0.30}[sensitivity]
    minimum_gap = max(1, round(fps * max(min_duration, minimum_shot_seconds)))
    selected = []
    for candidate in sorted(candidates, key=lambda item: item[0]):
        if not selected or candidate[0] - selected[-1][0] >= minimum_gap:
            selected.append(candidate)
        elif candidate[1] > selected[-1][1]:
            selected[-1] = candidate
    return selected


def frame_quality_metrics(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape[:2]
    longest_edge = max(height, width)
    if longest_edge > QUALITY_WIDTH:
        scale = QUALITY_WIDTH / longest_edge
        gray = cv2.resize(
            gray,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean = float(gray.mean())
    clipped = float(((gray <= 5) | (gray >= 250)).mean())
    luma_p99 = float(np.percentile(gray, 99))
    black_pixel_ratio = float((gray <= 12).mean())
    is_black = luma_p99 <= BLACK_FRAME_LUMA_P99 or (mean <= 10.0 and black_pixel_ratio >= 0.98)
    is_blurry = sharpness < MIN_FRAME_SHARPNESS
    # Extreme exposure and nearly blank frames should not win merely due to noise.
    exposure = max(0.0, 1.0 - abs(mean - 128.0) / 128.0) * (1.0 - clipped)
    return {
        "quality": sharpness * (0.35 + 0.65 * exposure),
        "sharpness": sharpness,
        "brightness": mean,
        "luma_p99": luma_p99,
        "black_pixel_ratio": black_pixel_ratio,
        "is_black": is_black,
        "is_blurry": is_blurry,
    }


def calculate_frame_quality(frame):
    """Keep the legacy tuple contract for callers that only need ranking data."""
    metrics = frame_quality_metrics(frame)
    return metrics["quality"], metrics["sharpness"], metrics["brightness"]


def extract_best_frames(video_path, shots, fps, original_name):
    cap = open_video(video_path)
    if not cap.isOpened():
        raise RuntimeError("无法重新打开视频以提取截图")

    output_dir = os.path.dirname(video_path)
    base_name = sanitize_filename(os.path.splitext(original_name)[0])
    metadata = []
    skipped_black_shots = 0
    skipped_blurry_shots = 0
    for number, (start, end) in enumerate(shots, 1):
        length = end - start + 1
        margin = min(max(2, round(fps * 0.15)), max(0, (length - 1) // 3))
        search_start, search_end = start + margin, end - margin
        stride = max(1, round((search_end - search_start + 1) / 90))
        cap.set(cv2.CAP_PROP_POS_FRAMES, search_start)

        best = None
        sampled_count = 0
        non_black_count = 0
        for frame_index in range(search_start, search_end + 1):
            ok, frame = cap.read()
            if not ok:
                break
            if (frame_index - search_start) % stride:
                continue
            sampled_count += 1
            metrics = frame_quality_metrics(frame)
            if metrics["is_black"]:
                continue
            non_black_count += 1
            if metrics["is_blurry"]:
                continue
            if best is None or metrics["quality"] > best[0]:
                best = (
                    metrics["quality"],
                    metrics["sharpness"],
                    metrics["brightness"],
                    metrics["luma_p99"],
                    metrics["black_pixel_ratio"],
                    frame_index,
                    frame,
                )

        if best is None:
            if sampled_count and not non_black_count:
                skipped_black_shots += 1
            elif non_black_count:
                skipped_blurry_shots += 1
            continue
        _, sharpness, brightness, luma_p99, black_pixel_ratio, frame_index, frame = best
        filename = f"{base_name}_{number:03d}_{frame_index / fps:.3f}s.jpg"
        output_path = os.path.join(output_dir, filename)
        ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        if not ok:
            continue
        with open(output_path, "wb") as target:
            target.write(encoded.tobytes())
        metadata.append({
            "shot": number,
            "start_seconds": round(start / fps, 3),
            "end_seconds": round(end / fps, 3),
            "selected_seconds": round(frame_index / fps, 3),
            "selected_frame": frame_index,
            "sharpness": round(sharpness, 2),
            "brightness": round(brightness, 2),
            "luma_p99": round(luma_p99, 2),
            "black_pixel_ratio": round(black_pixel_ratio, 4),
            "file": filename,
        })
    cap.release()
    if skipped_black_shots or skipped_blurry_shots:
        log_info(
            f"{original_name}：质量筛选跳过 {skipped_black_shots} 个黑场分镜、"
            f"{skipped_blurry_shots} 个无清晰候选帧的分镜"
        )
    return metadata


def analyze_video(video_path, sensitivity, min_duration):
    name = os.path.basename(video_path)
    log_info(f"正在分析视频：{name}")
    cap = open_video(video_path)
    if not cap.isOpened():
        return None
    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ok, first = cap.read()
    if not ok:
        cap.release()
        return None

    previous = preview_features(first)
    scores = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        current = preview_features(frame)
        scores.append(frame_difference(previous, current))
        previous = current
    cap.release()
    if not scores:
        return []

    boundaries = find_boundaries(scores, fps, sensitivity, min_duration)
    total = len(scores) + 1
    starts = [0] + [frame for frame, _, _ in boundaries]
    ends = [frame - 1 for frame, _, _ in boundaries] + [total - 1]
    shots = [(start, end) for start, end in zip(starts, ends) if end >= start]
    frames = extract_best_frames(video_path, shots, fps, name)
    log_info(f"{name}：识别 {len(boundaries)} 个转场，导出 {len(frames)} 张截图")
    return frames


def perceptual_hash(image, hash_size=8, highfreq_factor=4):
    """Return the same pHash value as ImageHash without its SciPy dependency."""
    if hash_size < 2:
        raise ValueError("Hash size must be greater than or equal to 2")
    image_size = hash_size * highfreq_factor
    pixels = np.asarray(
        image.convert("L").resize((image_size, image_size), Image.Resampling.LANCZOS),
        dtype=np.float64,
    )
    normalized_dct = cv2.dct(pixels)
    # OpenCV uses an orthonormal DCT while ImageHash/SciPy used the unnormalised
    # DCT-II. Restoring those scale factors keeps every existing hash bit stable.
    scales = np.full(image_size, np.sqrt(2.0 * image_size), dtype=np.float64)
    scales[0] = 2.0 * np.sqrt(image_size)
    coefficients = normalized_dct * scales[:, None] * scales[None, :]
    low_frequencies = coefficients[:hash_size, :hash_size]
    bits = (low_frequencies > np.median(low_frequencies)).flatten()
    bit_string = "".join("1" if value else "0" for value in bits)
    width = (len(bit_string) + 3) // 4
    return f"{int(bit_string, 2):0{width}x}"


def calculate_image_hash(file_path):
    try:
        with Image.open(file_path) as image:
            return perceptual_hash(image)
    except Exception:
        return None


def process_images_deduplication(directory):
    files = [path for path in Path(directory).iterdir() if path.suffix.lower() in IMAGE_EXTENSIONS]
    if not files:
        return
    hashes = {}
    for path in files:
        image_hash = calculate_image_hash(path)
        if image_hash:
            hashes.setdefault(image_hash, []).append(path)
    duplicates = []
    for paths in hashes.values():
        if len(paths) > 1:
            paths.sort(key=lambda path: path.stat().st_size, reverse=True)
            duplicates.extend(paths[1:])
    for path in duplicates:
        try:
            send2trash(str(path))
        except Exception:
            pass
    log_success(f"图片去重完成：移入回收站 {len(duplicates)} 张重复图片")


def move_txt_files(directory):
    txt_files = [path for path in Path(directory).iterdir() if path.suffix.lower() == ".txt"]
    if not txt_files:
        return
    data_dir = Path(directory) / "data"
    data_dir.mkdir(exist_ok=True)
    for path in txt_files:
        shutil.move(str(path), str(data_dir / path.name))
    log_info(f"已将 {len(txt_files)} 个 TXT 文件移至 data 文件夹")


def collect_video_inputs(raw_paths):
    """Expand selected files/folders into a stable, de-duplicated video list."""
    videos = []
    selected_directories = []
    seen_videos = set()
    seen_directories = set()
    missing_paths = []
    unsupported_paths = []

    for raw_path in raw_paths:
        target = Path(raw_path)
        if not target.exists():
            missing_paths.append(target)
            continue
        if target.is_file():
            if target.suffix.lower() not in VIDEO_EXTENSIONS:
                unsupported_paths.append(target)
                continue
            candidates = [target]
        elif target.is_dir():
            directory_key = os.path.normcase(os.path.abspath(target))
            if directory_key not in seen_directories:
                seen_directories.add(directory_key)
                selected_directories.append(target)
            candidates = sorted(
                (path for path in target.rglob("*") if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS),
                key=lambda path: os.path.normcase(str(path)),
            )
        else:
            unsupported_paths.append(target)
            continue
        for candidate in candidates:
            key = os.path.normcase(os.path.abspath(candidate))
            if key in seen_videos:
                continue
            seen_videos.add(key)
            videos.append(candidate)
    return videos, selected_directories, missing_paths, unsupported_paths


def run(args_list):
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", action="append", required=True, help="目标视频或文件夹，可重复传入")
    parser.add_argument("--sensitivity", choices=("low", "standard", "high"), help="转场检测灵敏度")
    parser.add_argument("--threshold", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--min_duration", type=float, default=0.2, help="最短镜头时长（秒）")
    parser.add_argument("--organize-data", action="store_true", help="把目录中的 TXT 文件移入 data 文件夹")
    args = parser.parse_args(args_list)
    videos, selected_directories, missing_paths, unsupported_paths = collect_video_inputs(args.path)
    for target in missing_paths:
        log_warning(f"路径不存在，已跳过：{target}")
    for target in unsupported_paths:
        log_warning(f"不是支持的视频文件或文件夹，已跳过：{target}")
    if not videos and not selected_directories:
        log_error("没有可处理的视频或文件夹")
        return
    log_progress("扫描视频文件…", 0)
    sensitivity = args.sensitivity or normalize_sensitivity(args.threshold)
    skipped_videos = []
    processed_videos = 0
    for index, video in enumerate(videos, 1):
        if detected_video_container(video) is None:
            skipped_videos.append(video.name)
        else:
            result = analyze_video(str(video), sensitivity, max(0.05, args.min_duration))
            if result is None:
                skipped_videos.append(video.name)
            else:
                processed_videos += 1
        log_progress(f"处理视频：{index}/{len(videos)}", int(index / max(1, len(videos)) * 90))
    if not videos:
        log_info("所选文件夹中未找到视频文件，跳过分镜识别")
    # Direct file selections must not reorganize unrelated sibling files. Folder
    # selections retain the legacy cleanup behavior for every directory in which
    # a selected-folder video produced frames.
    cleanup_directories = []
    seen_cleanup_directories = set()
    for video in videos:
        parent = video.parent
        if not any(parent == selected or selected in parent.parents for selected in selected_directories):
            continue
        key = os.path.normcase(os.path.abspath(parent))
        if key in seen_cleanup_directories:
            continue
        seen_cleanup_directories.add(key)
        cleanup_directories.append(parent)
    if selected_directories and not cleanup_directories:
        cleanup_directories = selected_directories
    for directory in cleanup_directories:
        process_images_deduplication(directory)
    if args.organize_data:
        for directory in selected_directories:
            move_txt_files(directory)
    if skipped_videos:
        preview_names = "、".join(f"“{name}”" for name in skipped_videos[:5])
        remaining = len(skipped_videos) - min(5, len(skipped_videos))
        suffix = f"等 {len(skipped_videos)} 个文件" if remaining else ""
        log_warning(
            f"已跳过 {preview_names}{suffix}：文件内容不是受支持的视频容器，或没有可解码的画面。",
            data={"skippedCount": len(skipped_videos), "processedCount": processed_videos},
        )
    log_progress("任务全部完成", 100)
    log_success(
        f"分镜处理完成：成功处理 {processed_videos} 个视频，跳过 {len(skipped_videos)} 个无效或不可读文件。",
        data={"processedCount": processed_videos, "skippedCount": len(skipped_videos)},
    )


if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as error:
        log_error(f"脚本发生严重错误：{error}")
        raise
