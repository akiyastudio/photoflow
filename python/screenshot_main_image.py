"""Extract the main artwork rectangle from screenshots without overwriting inputs."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np


SUPPORTED_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
MAX_ANALYSIS_EDGE = 1400
MIN_CONFIDENCE = 0.58


def _read_image(path: Path) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法读取图片；当前仅支持 JPG、PNG、BMP、WebP 和 TIFF")
    return image


def _smooth(values: np.ndarray, window: int) -> np.ndarray:
    window = max(3, int(window) | 1)
    return cv2.GaussianBlur(values.reshape(-1, 1).astype(np.float32), (1, window), 0).reshape(-1)


def _segments(mask: np.ndarray, minimum: int) -> list[tuple[int, int]]:
    padded = np.pad(mask.astype(np.int8), (1, 1))
    changes = np.flatnonzero(np.diff(padded))
    return [(int(start), int(end)) for start, end in changes.reshape(-1, 2) if end - start >= minimum]


def _merge_segments(parts: list[tuple[int, int]], maximum_gap: int) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for start, end in sorted(parts):
        if merged and start - merged[-1][1] <= maximum_gap:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def _analysis_maps(image: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    size = max(5, (min(image.shape[:2]) // 90) | 1)
    mean = cv2.boxFilter(gray, -1, (size, size), normalize=True)
    mean_square = cv2.boxFilter(gray * gray, -1, (size, size), normalize=True)
    local_std = np.sqrt(np.maximum(0.0, mean_square - mean * mean))
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient = cv2.magnitude(gx, gy)
    saturation = hsv[:, :, 1].astype(np.float32)
    active = ((local_std > 9.0) | (saturation > 34.0) | (gradient > 65.0)).astype(np.uint8)
    return gray, local_std, gradient, active


def _candidate_rectangles(
    image: np.ndarray,
    maps: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None,
    differences: tuple[np.ndarray, np.ndarray] | None = None,
) -> list[tuple[int, int, int, int]]:
    height, width = image.shape[:2]
    _gray, _local_std, _gradient, active = maps or _analysis_maps(image)
    min_height = max(24, int(height * 0.13))
    min_width = max(24, int(width * 0.34))
    row_activity = _smooth(active.mean(axis=1), max(5, height // 90))
    adaptive_row_threshold = float(np.clip(np.percentile(row_activity, 58) * 0.78, 0.16, 0.46))
    row_parts = _merge_segments(
        _segments(row_activity > adaptive_row_threshold, max(8, height // 45)),
        max(4, height // 45),
    )

    candidates: list[tuple[int, int, int, int]] = []
    for top, bottom in row_parts:
        if bottom - top < min_height:
            continue
        band_active = active[top:bottom]
        column_activity = _smooth(band_active.mean(axis=0), max(5, width // 100))
        column_threshold = float(np.clip(np.percentile(column_activity, 55) * 0.68, 0.12, 0.40))
        column_parts = _merge_segments(
            _segments(column_activity > column_threshold, max(8, width // 60)),
            max(4, width // 35),
        )
        plausible = [(left, right) for left, right in column_parts if right - left >= min_width]
        if plausible:
            left, right = max(plausible, key=lambda part: part[1] - part[0])
        else:
            left, right = 0, width
        candidates.append((left, top, right, bottom))

    # Closed texture regions are useful when the artwork is inset from a uniform app background.
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (max(3, width // 55), max(3, height // 80)),
    )
    region_mask = cv2.morphologyEx(active * 255, cv2.MORPH_CLOSE, kernel, iterations=2)
    region_mask = cv2.morphologyEx(region_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(region_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        left, top, candidate_width, candidate_height = cv2.boundingRect(contour)
        if candidate_width >= min_width and candidate_height >= min_height:
            candidates.append((left, top, left + candidate_width, top + candidate_height))

    # Strong horizontal transitions often mark the media boundaries in social-app screenshots.
    row_difference = differences[0] if differences is not None else np.mean(np.abs(np.diff(image.astype(np.float32), axis=0)), axis=(1, 2))
    row_difference = _smooth(row_difference, max(3, height // 240))
    peak_threshold = max(float(np.percentile(row_difference, 82)), float(row_difference.mean() + row_difference.std() * 0.45))
    peak_indexes = np.flatnonzero(row_difference >= peak_threshold) + 1
    grouped_peaks = _merge_segments([(int(index), int(index) + 1) for index in peak_indexes], max(3, height // 100))
    peak_centers = [int((start + end) / 2) for start, end in grouped_peaks]
    if len(peak_centers) > 28:
        peak_centers = sorted(
            peak_centers,
            key=lambda center: row_difference[min(len(row_difference) - 1, max(0, center - 1))],
            reverse=True,
        )[:28]
    boundaries = [0, height, *peak_centers]
    boundaries = sorted(set(boundaries))
    row_scale = max(3.0, float(np.percentile(row_difference, 85)))
    for first_index, top in enumerate(boundaries):
        for bottom in boundaries[first_index + 1:]:
            candidate_height = bottom - top
            if candidate_height < min_height or candidate_height > height * 0.88:
                continue
            top_boundary = row_difference[max(0, top - 1)] if top else 0.0
            bottom_boundary = row_difference[min(len(row_difference) - 1, bottom - 1)] if bottom < height else 0.0
            pixel_boundary_threshold = max(18.0, row_scale * 1.5)
            top_boundary_coverage = 0.0 if not top else float(np.mean(
                np.mean(np.abs(image[top].astype(np.float32) - image[top - 1].astype(np.float32)), axis=1)
                >= pixel_boundary_threshold
            ))
            bottom_boundary_coverage = 0.0 if bottom >= height else float(np.mean(
                np.mean(np.abs(image[bottom].astype(np.float32) - image[bottom - 1].astype(np.float32)), axis=1)
                >= pixel_boundary_threshold
            ))
            strong_horizontal_frame = (
                top > 0
                and bottom < height
                and top_boundary >= row_scale * 4.0
                and bottom_boundary >= row_scale * 4.0
                and top_boundary_coverage >= 0.94
                and bottom_boundary_coverage >= 0.94
            )
            if strong_horizontal_frame:
                # Sparse sketches and line art can have almost no texture away
                # from their strokes.  Their two full-width frame transitions
                # are still reliable evidence for the complete artwork panel.
                candidates.append((0, top, width, bottom))
            band_active = active[top:bottom]
            if float(band_active.mean()) < 0.19:
                continue
            column_activity = _smooth(band_active.mean(axis=0), max(5, width // 100))
            parts = _merge_segments(_segments(column_activity > 0.15, max(8, width // 70)), max(4, width // 40))
            plausible = [(left, right) for left, right in parts if right - left >= min_width]
            left, right = max(plausible, key=lambda part: part[1] - part[0]) if plausible else (0, width)
            candidates.append((left, top, right, bottom))

    # Deduplicate near-identical rectangles.
    column_difference = differences[1] if differences is not None else np.mean(np.abs(np.diff(image.astype(np.float32), axis=1)), axis=(0, 2))
    unique: list[tuple[int, int, int, int]] = []
    for rectangle in candidates:
        rectangle = _snap_rectangle_to_boundaries(image, rectangle, (row_difference, column_difference))
        rectangle = _expand_weak_single_sided_crops(
            rectangle,
            (row_difference, column_difference),
            width,
            height,
        )
        if rectangle[2] - rectangle[0] < min_width or rectangle[3] - rectangle[1] < min_height:
            continue
        if not any(sum(abs(a - b) for a, b in zip(rectangle, saved)) < (width + height) * 0.025 for saved in unique):
            unique.append(rectangle)
    return unique


def _snap_edge(values: np.ndarray, position: int, radius: int, maximum: int) -> int:
    if position <= 0 or position >= maximum:
        return position
    start = max(1, position - radius)
    end = min(maximum - 1, position + radius)
    if end <= start:
        return position
    window = values[start - 1:end]
    offset = int(np.argmax(window))
    strongest = float(window[offset])
    if strongest < max(3.0, float(np.percentile(values, 78)) * 1.35):
        return position
    return start + offset


def _snap_rectangle_to_boundaries(
    image: np.ndarray,
    rectangle: tuple[int, int, int, int],
    differences: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[int, int, int, int]:
    height, width = image.shape[:2]
    left, top, right, bottom = rectangle
    if differences is None:
        row_difference = np.mean(np.abs(np.diff(image.astype(np.float32), axis=0)), axis=(1, 2))
        column_difference = np.mean(np.abs(np.diff(image.astype(np.float32), axis=1)), axis=(0, 2))
    else:
        row_difference, column_difference = differences
    return (
        _snap_edge(column_difference, left, max(4, width // 45), width),
        _snap_edge(row_difference, top, max(4, height // 45), height),
        _snap_edge(column_difference, right, max(4, width // 45), width),
        _snap_edge(row_difference, bottom, max(4, height // 45), height),
    )


def _expand_weak_single_sided_crops(
    rectangle: tuple[int, int, int, int],
    differences: tuple[np.ndarray, np.ndarray],
    width: int,
    height: int,
) -> tuple[int, int, int, int]:
    """Do not remove one side of a screenshot without a credible boundary.

    Texture masks frequently stop at the subject rather than at the edge of the
    actual picture.  When that happens the old detector could keep the outer
    edge on one side and cut through the artwork on the other.  Expanding a
    weak, single-sided crop is intentionally conservative: missing a little UI
    is preferable to deleting part of the main image.
    """
    row_difference, column_difference = differences
    left, top, right, bottom = rectangle
    row_threshold = max(3.0, float(np.percentile(row_difference, 78)) * 1.35)
    column_threshold = max(3.0, float(np.percentile(column_difference, 78)) * 1.35)

    if left > 0 and right >= width:
        if float(column_difference[min(len(column_difference) - 1, left - 1)]) < column_threshold:
            left = 0
    elif left <= 0 and right < width:
        if float(column_difference[min(len(column_difference) - 1, right - 1)]) < column_threshold:
            right = width

    if top > 0 and bottom >= height:
        if float(row_difference[min(len(row_difference) - 1, top - 1)]) < row_threshold:
            top = 0
    elif top <= 0 and bottom < height:
        if float(row_difference[min(len(row_difference) - 1, bottom - 1)]) < row_threshold:
            bottom = height
    return left, top, right, bottom


def _outside_strip_score(values: np.ndarray, rectangle: tuple[int, int, int, int]) -> float:
    left, top, right, bottom = rectangle
    height, width = values.shape[:2]
    strips: list[np.ndarray] = []
    pad_y = max(4, height // 40)
    pad_x = max(4, width // 40)
    if top:
        strips.append(values[max(0, top - pad_y):top, left:right])
    if bottom < height:
        strips.append(values[bottom:min(height, bottom + pad_y), left:right])
    if left:
        strips.append(values[top:bottom, max(0, left - pad_x):left])
    if right < width:
        strips.append(values[top:bottom, right:min(width, right + pad_x)])
    usable = [strip for strip in strips if strip.size]
    return float(np.mean([strip.mean() for strip in usable])) if usable else 0.0


def _score_candidate(
    image: np.ndarray,
    rectangle: tuple[int, int, int, int],
    maps: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None,
    differences: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[float, dict[str, float]]:
    height, width = image.shape[:2]
    left, top, right, bottom = rectangle
    candidate_width = right - left
    candidate_height = bottom - top
    area_ratio = candidate_width * candidate_height / float(width * height)
    width_ratio = candidate_width / width
    height_ratio = candidate_height / height
    _gray, local_std, gradient, active = maps or _analysis_maps(image)
    inside_std = float(local_std[top:bottom, left:right].mean())
    outside_std = _outside_strip_score(local_std, rectangle)
    inside_gradient = float(gradient[top:bottom, left:right].mean())
    active_fraction = float(active[top:bottom, left:right].mean())
    row_coverage = active[top:bottom, left:right].mean(axis=1)
    continuity = float(np.mean(row_coverage > 0.20))
    contrast = float(np.clip((inside_std - outside_std + 5.0) / 30.0, 0.0, 1.0))
    texture = float(np.clip(inside_std / 34.0, 0.0, 1.0))
    edge = float(np.clip(inside_gradient / 120.0, 0.0, 1.0))
    activity = float(np.clip((active_fraction - 0.12) / 0.55, 0.0, 1.0))
    size_score = float(np.clip((area_ratio - 0.10) / 0.32, 0.0, 1.0))
    if area_ratio > 0.82:
        size_score *= max(0.0, (0.96 - area_ratio) / 0.14)
    width_score = float(np.clip((width_ratio - 0.33) / 0.42, 0.0, 1.0))
    center_x = (left + right) / (2 * width)
    center_score = float(np.clip(1.0 - abs(center_x - 0.5) / 0.36, 0.0, 1.0))
    margin_ratio = (top + height - bottom + left + width - right) / float(2 * (width + height))
    margin_score = float(np.clip(margin_ratio / 0.075, 0.0, 1.0))
    if differences is None:
        row_difference = np.mean(np.abs(np.diff(image.astype(np.float32), axis=0)), axis=(1, 2))
        column_difference = np.mean(np.abs(np.diff(image.astype(np.float32), axis=1)), axis=(0, 2))
    else:
        row_difference, column_difference = differences
    row_scale = max(3.0, float(np.percentile(row_difference, 85)))
    column_scale = max(3.0, float(np.percentile(column_difference, 85)))
    boundary_values = [
        row_difference[max(0, top - 1)] if top else 0.0,
        row_difference[min(len(row_difference) - 1, bottom - 1)] if bottom < height else 0.0,
        column_difference[max(0, left - 1)] if left else 0.0,
        column_difference[min(len(column_difference) - 1, right - 1)] if right < width else 0.0,
    ]
    boundary = float(np.mean([
        np.clip(boundary_values[0] / (row_scale * 2.5), 0.0, 1.0),
        np.clip(boundary_values[1] / (row_scale * 2.5), 0.0, 1.0),
        np.clip(boundary_values[2] / (column_scale * 2.5), 0.0, 1.0),
        np.clip(boundary_values[3] / (column_scale * 2.5), 0.0, 1.0),
    ]))
    # A screenshot often contains a full-width image between a status/header
    # strip and a footer strip.  Two exceptionally strong opposing transitions
    # are much better frame evidence than a dense subject-shaped texture blob.
    horizontal_frame = (
        width_ratio >= 0.90
        and top > 0
        and bottom < height
        and boundary_values[0] >= row_scale * 4.0
        and boundary_values[1] >= row_scale * 4.0
    )
    vertical_frame = (
        height_ratio >= 0.90
        and left > 0
        and right < width
        and boundary_values[2] >= column_scale * 4.0
        and boundary_values[3] >= column_scale * 4.0
    )
    frame = 1.0 if horizontal_frame or vertical_frame else 0.0

    # A text-only note normally has many edges but low continuous texture and
    # low color activity.  Do not apply that penalty when two strong opposing
    # frame edges already identify the complete media panel: sparse line art is
    # intentionally low-texture and would otherwise look text-like here.
    text_like_penalty = 0.0
    if not frame:
        if continuity < 0.58:
            text_like_penalty += (0.58 - continuity) * 0.45
        if texture < 0.32 and edge > 0.20:
            text_like_penalty += 0.16
        if height_ratio < 0.18 or width_ratio < 0.40:
            text_like_penalty += 0.18

    score = (
        0.17 * size_score
        + 0.14 * texture
        + 0.10 * edge
        + 0.12 * activity
        + 0.12 * continuity
        + 0.09 * contrast
        + 0.14 * boundary
        + 0.06 * width_score
        + 0.04 * center_score
        + 0.04 * margin_score
        + 0.35 * frame
        - text_like_penalty
    )
    features = {
        "area": area_ratio,
        "texture": texture,
        "activity": activity,
        "continuity": continuity,
        "contrast": contrast,
        "margin": margin_ratio,
        "boundary": boundary,
        "frame": frame,
    }
    return float(np.clip(score, 0.0, 1.0)), features


def detect_main_rectangle(image: np.ndarray) -> tuple[tuple[int, int, int, int] | None, float, str]:
    original_height, original_width = image.shape[:2]
    if original_height < 160 or original_width < 120:
        return None, 0.0, "图片尺寸过小"
    scale = min(1.0, MAX_ANALYSIS_EDGE / max(original_height, original_width))
    analysis = image if scale == 1.0 else cv2.resize(
        image,
        (max(1, round(original_width * scale)), max(1, round(original_height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    maps = _analysis_maps(analysis)
    differences = (
        np.mean(np.abs(np.diff(analysis.astype(np.float32), axis=0)), axis=(1, 2)),
        np.mean(np.abs(np.diff(analysis.astype(np.float32), axis=1)), axis=(0, 2)),
    )
    candidates = _candidate_rectangles(analysis, maps, differences)
    if not candidates:
        return None, 0.0, "没有找到可信的主图区域"
    scored = [(*_score_candidate(analysis, rectangle, maps, differences), rectangle) for rectangle in candidates]
    score, features, rectangle = max(scored, key=lambda item: item[0])
    height, width = analysis.shape[:2]
    left, top, right, bottom = rectangle
    removed_ratio = 1.0 - ((right - left) * (bottom - top) / float(width * height))
    if removed_ratio < 0.06:
        return None, score, "图片本身已接近完整画面，无需裁剪"
    if not features["frame"] and (features["continuity"] < 0.44 or (
        features["texture"] < 0.16
        and features["activity"] < 0.28
        and features["boundary"] < 0.70
    )):
        return None, score, "画面更像文字或界面，已为避免误裁而跳过"
    if score < MIN_CONFIDENCE:
        return None, score, "主图区域置信度不足，已保留原图"
    inverse_scale = 1.0 / scale
    resolved = (
        max(0, round(left * inverse_scale)),
        max(0, round(top * inverse_scale)),
        min(original_width, round(right * inverse_scale)),
        min(original_height, round(bottom * inverse_scale)),
    )
    if resolved[2] - resolved[0] < 80 or resolved[3] - resolved[1] < 80:
        return None, score, "检测到的区域过小，已保留原图"
    # The frame itself is the main-image boundary.  Trimming uniform white or
    # black lines inside it would remove intentional canvas around sparse art.
    if features["frame"]:
        return resolved, score, ""
    return _trim_uniform_borders(image, resolved), score, ""


def _trim_uniform_borders(image: np.ndarray, rectangle: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    left, top, right, bottom = rectangle
    crop = image[top:bottom, left:right]
    height, width = crop.shape[:2]
    if height < 120 or width < 120:
        return rectangle

    def uniform_line(line: np.ndarray) -> bool:
        flattened = line.reshape(-1, 3).astype(np.float32)
        channel_mean = flattened.mean(axis=0)
        return bool(flattened.std(axis=0).max() < 4.0 and (channel_mean.max() < 11.0 or channel_mean.min() > 244.0))

    maximum_y = max(1, int(height * 0.18))
    maximum_x = max(1, int(width * 0.18))
    top_trim = next((index for index in range(maximum_y) if not uniform_line(crop[index:index + 1, :])), maximum_y)
    bottom_trim = next((index for index in range(maximum_y) if not uniform_line(crop[height - index - 1:height - index, :])), maximum_y)
    left_trim = next((index for index in range(maximum_x) if not uniform_line(crop[:, index:index + 1])), maximum_x)
    right_trim = next((index for index in range(maximum_x) if not uniform_line(crop[:, width - index - 1:width - index])), maximum_x)
    if top_trim < max(2, int(height * 0.008)):
        top_trim = 0
    if bottom_trim < max(2, int(height * 0.008)):
        bottom_trim = 0
    if left_trim < max(2, int(width * 0.008)):
        left_trim = 0
    if right_trim < max(2, int(width * 0.008)):
        right_trim = 0
    if width - left_trim - right_trim < 80 or height - top_trim - bottom_trim < 80:
        return rectangle
    return left + left_trim, top + top_trim, right - right_trim, bottom - bottom_trim


def _unique_output_path(source: Path) -> Path:
    suffix = source.suffix.lower() if source.suffix.lower() in SUPPORTED_EXTENSIONS else ".png"
    for index in range(1, 10000):
        extra = "" if index == 1 else f"_{index}"
        candidate = source.with_name(f"{source.stem}_主图{extra}{suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError("无法创建唯一的输出文件名")


def _write_image_atomic(destination: Path, image: np.ndarray) -> None:
    suffix = destination.suffix.lower()
    params: list[int] = []
    if suffix in {".jpg", ".jpeg"}:
        params = [cv2.IMWRITE_JPEG_QUALITY, 95]
    elif suffix == ".png":
        params = [cv2.IMWRITE_PNG_COMPRESSION, 3]
    success, encoded = cv2.imencode(suffix, image, params)
    if not success:
        raise RuntimeError("无法编码裁剪后的图片")
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.photoflow-part")
    try:
        encoded.tofile(temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def extract_main_image(input_path: str) -> dict[str, object]:
    source = Path(input_path).resolve()
    result: dict[str, object] = {
        "input": str(source),
        "inputName": source.name,
        "success": False,
        "cropped": False,
    }
    try:
        if not source.is_file():
            raise ValueError("图片不存在")
        if source.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError("当前仅支持 JPG、PNG、BMP、WebP 和 TIFF")
        image = _read_image(source)
        original_height, original_width = image.shape[:2]
        rectangle, confidence, reason = detect_main_rectangle(image)
        result["confidence"] = round(confidence, 4)
        result["originalSize"] = {"width": original_width, "height": original_height}
        if rectangle is None:
            result.update(success=True, skipped=True, reason=reason)
            return result
        left, top, right, bottom = rectangle
        cropped = image[top:bottom, left:right]
        destination = _unique_output_path(source)
        _write_image_atomic(destination, cropped)
        result.update(
            success=True,
            cropped=True,
            output=str(destination),
            outputName=destination.name,
            crop={"x": left, "y": top, "width": right - left, "height": bottom - top},
            outputSize={"width": right - left, "height": bottom - top},
        )
        return result
    except Exception as error:
        result["error"] = str(error)
        return result


def run(args_list: list[str]) -> None:
    parser = argparse.ArgumentParser(description="从截图中提取主图")
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--input", action="append", required=True, dest="inputs")
    args = parser.parse_args(args_list)

    results = []
    total = len(args.inputs)
    for index, input_path in enumerate(args.inputs, start=1):
        input_name = Path(input_path).name
        print(json.dumps({
            "type": "progress",
            "phase": "item-start",
            "processedCount": index - 1,
            "totalCount": total,
            "progress": round((index - 1) / max(1, total) * 100),
            "currentName": input_name,
            "message": f"正在识别 {index}/{total} · {input_name}",
        }, ensure_ascii=True), flush=True)
        results.append(extract_main_image(input_path))
        print(json.dumps({
            "type": "progress",
            "phase": "item-complete",
            "processedCount": index,
            "totalCount": total,
            "progress": round(index / max(1, total) * 100),
            "currentName": input_name,
            "message": f"已处理 {index}/{total} · {input_name}",
        }, ensure_ascii=True), flush=True)
    cropped_count = sum(bool(result.get("cropped")) for result in results)
    skipped_count = sum(bool(result.get("skipped")) for result in results)
    failed_count = sum(not bool(result.get("success")) for result in results)
    payload: dict[str, object] = {
        "success": failed_count < len(results),
        "inputCount": len(results),
        "croppedCount": cropped_count,
        "skippedCount": skipped_count,
        "failedCount": failed_count,
        "results": results,
    }
    if failed_count == len(results):
        payload["error"] = str(results[0].get("error") or "提取截图主图失败")
    # Keep the pipe protocol ASCII-only. Packaged Python executables on
    # Chinese Windows can otherwise encode redirected stdout as GBK while
    # Electron correctly expects UTF-8, corrupting every Chinese path.
    print(json.dumps(payload, ensure_ascii=True))


if __name__ == "__main__":
    import sys

    run(sys.argv[1:])
