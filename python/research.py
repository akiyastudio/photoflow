import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import cv2
import imagehash
import numpy as np
from PIL import Image
from send2trash import send2trash


VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".m4v", ".webm"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
PREVIEW_WIDTH = 384


def emit(event_type, message, data=None, progress=None):
    payload = {"type": event_type, "message": message}
    if data is not None:
        payload["data"] = data
    if progress is not None:
        payload["progress"] = progress
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def log_info(message):
    emit("log", message)


def log_success(message):
    emit("success", message)


def log_error(message):
    emit("error", message)


def log_progress(message, percent):
    emit("progress", message, progress=int(percent))


def sanitize_filename(filename):
    invalid_chars = r'\\/:*?"<>|'
    filename = "".join("_" if char in invalid_chars else char for char in filename)
    return "".join(char for char in filename if ord(char) >= 32).strip()


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


def robust_thresholds(scores, legacy_ssim_threshold):
    values = np.asarray(scores, dtype=np.float32)
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median))) + 1e-6
    # Keep --threshold compatible with the old SSIM control: lower SSIM means the
    # user accepts more change inside one shot, therefore detection is less sensitive.
    user_floor = 0.04 + max(0.0, min(1.0, 1.0 - legacy_ssim_threshold))
    hard = max(user_floor, float(np.quantile(values, 0.92)), median + 4.0 * mad)
    soft = max(0.018, median + 1.5 * mad)
    return hard, min(soft, hard * 0.85)


def find_boundaries(scores, fps, legacy_ssim_threshold, min_duration):
    if not scores:
        return []
    hard, soft = robust_thresholds(scores, legacy_ssim_threshold)
    candidates = []

    # Sharp cuts are local maxima above the per-video adaptive threshold.
    for index, score in enumerate(scores):
        left = scores[index - 1] if index else -1.0
        right = scores[index + 1] if index + 1 < len(scores) else -1.0
        if score >= hard and score >= left and score >= right:
            candidates.append((index + 1, score, "cut"))

    # A fade/dissolve yields a run of moderate change instead of one large peak.
    run_start = None
    max_index = -1
    max_score = -1.0
    max_gap = max(1, round(fps * 0.08))
    last_active = -1
    for index, score in enumerate(scores):
        if score >= soft:
            if run_start is None or index - last_active > max_gap:
                if run_start is not None and last_active - run_start + 1 >= max(2, round(fps * 0.12)):
                    candidates.append((max_index + 1, max_score, "gradual"))
                run_start, max_index, max_score = index, index, score
            elif score > max_score:
                max_index, max_score = index, score
            last_active = index
    if run_start is not None and last_active - run_start + 1 >= max(2, round(fps * 0.12)):
        candidates.append((max_index + 1, max_score, "gradual"))

    # Do not create unusably short shots.  For conflicting detections retain the
    # stronger one, which is normally the actual edit point.
    minimum_gap = max(1, round(fps * min_duration))
    selected = []
    for candidate in sorted(candidates, key=lambda item: item[0]):
        if not selected or candidate[0] - selected[-1][0] >= minimum_gap:
            selected.append(candidate)
        elif candidate[1] > selected[-1][1]:
            selected[-1] = candidate
    return selected


def calculate_frame_quality(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean = float(gray.mean())
    clipped = float(((gray <= 5) | (gray >= 250)).mean())
    # Extreme exposure and nearly blank frames should not win merely due to noise.
    exposure = max(0.0, 1.0 - abs(mean - 128.0) / 128.0) * (1.0 - clipped)
    return sharpness * (0.35 + 0.65 * exposure), sharpness, mean


def extract_best_frames(video_path, shots, fps, original_name):
    cap = cv2.VideoCapture(video_path, cv2.CAP_ANY)
    if not cap.isOpened():
        raise RuntimeError("无法重新打开视频以提取截图")

    output_dir = os.path.dirname(video_path)
    base_name = sanitize_filename(os.path.splitext(original_name)[0])
    metadata = []
    for number, (start, end) in enumerate(shots, 1):
        length = end - start + 1
        margin = min(max(2, round(fps * 0.15)), max(0, (length - 1) // 3))
        search_start, search_end = start + margin, end - margin
        stride = max(1, round((search_end - search_start + 1) / 90))
        cap.set(cv2.CAP_PROP_POS_FRAMES, search_start)

        best = None
        for frame_index in range(search_start, search_end + 1):
            ok, frame = cap.read()
            if not ok:
                break
            if (frame_index - search_start) % stride:
                continue
            quality, sharpness, brightness = calculate_frame_quality(frame)
            if best is None or quality > best[0]:
                best = (quality, sharpness, brightness, frame_index, frame)

        if best is None:
            continue
        _, sharpness, brightness, frame_index, frame = best
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
            "file": filename,
        })
    cap.release()
    return metadata


def analyze_video(video_path, threshold, min_duration):
    name = os.path.basename(video_path)
    log_info(f"正在分析视频：{name}")
    cap = cv2.VideoCapture(video_path, cv2.CAP_ANY)
    if not cap.isOpened():
        log_error(f"无法打开视频：{name}")
        return []
    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ok, first = cap.read()
    if not ok:
        cap.release()
        log_error(f"视频没有可读取的画面：{name}")
        return []

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

    boundaries = find_boundaries(scores, fps, threshold, min_duration)
    total = len(scores) + 1
    starts = [0] + [frame for frame, _, _ in boundaries]
    ends = [frame - 1 for frame, _, _ in boundaries] + [total - 1]
    shots = [(start, end) for start, end in zip(starts, ends) if end >= start]
    frames = extract_best_frames(video_path, shots, fps, name)
    report_path = os.path.join(os.path.dirname(video_path), f"{sanitize_filename(os.path.splitext(name)[0])}_shots.json")
    report = {
        "video": name,
        "fps": round(fps, 3),
        "frames_read": total,
        "transitions": [{"frame": frame, "seconds": round(frame / fps, 3), "type": kind, "score": round(score, 4)} for frame, score, kind in boundaries],
        "shots": frames,
    }
    with open(report_path, "w", encoding="utf-8") as target:
        json.dump(report, target, ensure_ascii=False, indent=2)
    log_info(f"{name}：识别 {len(boundaries)} 个转场，导出 {len(frames)} 张截图")
    return frames


def calculate_image_hash(file_path):
    try:
        with Image.open(file_path) as image:
            return str(imagehash.phash(image))
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


def run(args_list):
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True, help="目标工作目录")
    parser.add_argument("--threshold", type=float, default=0.95, help="镜头稳定度（兼容旧 SSIM 设置）")
    parser.add_argument("--min_duration", type=float, default=0.2, help="最短镜头时长（秒）")
    args = parser.parse_args(args_list)
    target = Path(args.path)
    if not target.is_dir():
        log_error(f"路径不存在：{target}")
        return
    videos = [path for path in target.iterdir() if path.suffix.lower() in VIDEO_EXTENSIONS]
    log_progress("扫描视频文件…", 0)
    for index, video in enumerate(videos, 1):
        analyze_video(str(video), args.threshold, max(0.05, args.min_duration))
        log_progress(f"处理视频：{index}/{len(videos)}", int(index / max(1, len(videos)) * 90))
    if not videos:
        log_info("目录中未找到视频文件，跳过分镜识别")
    process_images_deduplication(target)
    move_txt_files(target)
    log_progress("任务全部完成", 100)
    log_success("所有任务处理完毕")


if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as error:
        log_error(f"脚本发生严重错误：{error}")
        raise
