"""Seam-safe high-resolution Patch recomposition for the team-retouch component."""

from __future__ import annotations

import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageOps


Image.MAX_IMAGE_PIXELS = None


def emit(result):
    print(json.dumps(result, ensure_ascii=False), flush=True)


def load_rgb(path):
    with Image.open(path) as source:
        source.load()
        oriented = ImageOps.exif_transpose(source)
        metadata = {
            "icc_profile": source.info.get("icc_profile"),
            "exif": oriented.getexif().tobytes() if oriented.getexif() else None,
            "dpi": source.info.get("dpi"),
        }
        return np.asarray(oriented.convert("RGB")), metadata


def align_patch(base_rgb, edited_rgb):
    height, width = base_rgb.shape[:2]
    if edited_rgb.shape[:2] != (height, width):
        edited_rgb = cv2.resize(edited_rgb, (width, height), interpolation=cv2.INTER_LANCZOS4)
    scale = min(1.0, 1100.0 / max(height, width))
    base_small = cv2.resize(base_rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else base_rgb
    edit_small = cv2.resize(edited_rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else edited_rgb
    template = cv2.cvtColor(base_small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    moving = cv2.cvtColor(edit_small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    border_mask = np.ones(template.shape, np.uint8) * 255
    margin_y = max(8, int(template.shape[0] * 0.13))
    margin_x = max(8, int(template.shape[1] * 0.13))
    border_mask[margin_y:-margin_y, margin_x:-margin_x] = 0
    warp = np.eye(2, 3, dtype=np.float32)
    score = 0.0
    try:
        score, warp = cv2.findTransformECC(template, moving, warp, cv2.MOTION_AFFINE,
                                           (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5), border_mask, 3)
        warp[:, 2] /= scale
        aligned = cv2.warpAffine(edited_rgb, warp, (width, height), flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP,
                                 borderMode=cv2.BORDER_REFLECT_101)
        return aligned, float(score)
    except cv2.error:
        return edited_rgb, score


def border_mask(height, width, fraction=0.12):
    y, x = np.ogrid[:height, :width]
    distance = np.minimum.reduce((x + np.zeros_like(y), width - 1 - x + np.zeros_like(y),
                                  y + np.zeros_like(x), height - 1 - y + np.zeros_like(x))).astype(np.float32)
    feather = max(24.0, min(height, width) * fraction)
    normalized = np.clip(distance / feather, 0.0, 1.0)
    return normalized * normalized * (3.0 - 2.0 * normalized)


def match_border_color(base_rgb, edited_rgb):
    height, width = base_rgb.shape[:2]
    ring = border_mask(height, width, 0.14) < 0.58
    base_lab = cv2.cvtColor(base_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    edit_lab = cv2.cvtColor(edited_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    adjusted = edit_lab.copy()
    for channel in range(3):
        base_values = base_lab[..., channel][ring]
        edit_values = edit_lab[..., channel][ring]
        base_mean, edit_mean = float(base_values.mean()), float(edit_values.mean())
        base_std, edit_std = float(base_values.std()), max(1.0, float(edit_values.std()))
        scale = float(np.clip(base_std / edit_std, 0.82, 1.22))
        adjusted[..., channel] = (adjusted[..., channel] - edit_mean) * scale + base_mean
    return cv2.cvtColor(np.clip(adjusted, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)


def edit_weight_and_delta(base_rgb, edited_rgb):
    base_float = base_rgb.astype(np.float32)
    edit_float = edited_rgb.astype(np.float32)
    base_low = cv2.GaussianBlur(base_float, (0, 0), 1.15)
    edit_low = cv2.GaussianBlur(edit_float, (0, 0), 1.15)
    difference = np.mean(np.abs(edit_low - base_low), axis=2)
    noise = float(np.median(difference))
    deviation = float(np.median(np.abs(difference - noise)))
    threshold = max(2.8, noise + deviation * 1.8)
    strength = np.clip((difference - threshold * 0.55) / max(7.0, threshold * 1.4), 0.0, 1.0)
    changed = (strength > 0.08).astype(np.uint8) * 255
    radius = max(5, int(min(base_rgb.shape[:2]) * 0.012))
    radius += 1 - radius % 2
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius, radius))
    changed = cv2.morphologyEx(changed, cv2.MORPH_CLOSE, kernel)
    changed = cv2.dilate(changed, kernel, iterations=1)
    soft_changed = cv2.GaussianBlur(changed.astype(np.float32) / 255.0, (0, 0), max(3.0, radius * 0.65))
    weight = border_mask(base_rgb.shape[0], base_rgb.shape[1]) * np.maximum(strength, soft_changed * 0.72)
    # Re-inject only trustworthy high-frequency detail from the source.
    original_detail = base_float - base_low
    detail_factor = 0.62 * (1.0 - np.clip(weight[..., None] * 0.78, 0.0, 0.78))
    enhanced = np.clip(edit_float + original_detail * detail_factor, 0, 255)
    return weight.astype(np.float32), enhanced - base_float, {"noise": noise, "threshold": threshold}


def task_mask_weight(task, image_width, image_height, crop):
    """Return a soft target-person mask in crop coordinates.

    Detection masks are stored as full-image proxy PNGs.  The work patch stays
    rectangular and contains all context; this mask only prevents a returned
    patch from changing another person in an overlapping work area.
    """
    mask_path = task.get("maskPath")
    if not mask_path or not os.path.isfile(mask_path):
        return None
    with Image.open(mask_path) as source:
        source.load()
        full_proxy = np.asarray(source.convert("L"))
    x, y, crop_width, crop_height = crop
    proxy_height, proxy_width = full_proxy.shape[:2]
    scale_x = proxy_width / image_width
    scale_y = proxy_height / image_height
    left = max(0, min(proxy_width - 1, int(np.floor(x * scale_x))))
    top = max(0, min(proxy_height - 1, int(np.floor(y * scale_y))))
    right = max(left + 1, min(proxy_width, int(np.ceil((x + crop_width) * scale_x))))
    bottom = max(top + 1, min(proxy_height, int(np.ceil((y + crop_height) * scale_y))))
    proxy_crop = full_proxy[top:bottom, left:right]
    target = cv2.resize(proxy_crop, (crop_width, crop_height), interpolation=cv2.INTER_LINEAR) / 255.0
    radius = max(9, int(min(crop_height, crop_width) * 0.009))
    radius += 1 - radius % 2
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius, radius))
    expanded = cv2.dilate((target > 0.28).astype(np.uint8), kernel).astype(np.float32)
    return cv2.GaussianBlur(expanded, (0, 0), max(3.0, radius * 0.42))


def save_tiff(path, rgb, metadata):
    options = {"format": "TIFF", "compression": "tiff_deflate"}
    if metadata.get("icc_profile"):
        options["icc_profile"] = metadata["icc_profile"]
    if metadata.get("exif"):
        options["exif"] = metadata["exif"]
    if metadata.get("dpi"):
        options["dpi"] = metadata["dpi"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(rgb.astype(np.uint8), "RGB").save(path, **options)


def merge(input_path, manifest_path, output_path):
    base_rgb, metadata = load_rgb(input_path)
    with open(manifest_path, "r", encoding="utf-8") as source:
        manifest = json.load(source)
    height, width = base_rgb.shape[:2]
    # Keep only an 8-bit working image plus a half-float coverage map. A full
    # A full high-resolution float RGB accumulator would exceed 1 GB once temporary arrays are
    # included; crop-local weighted updates keep memory bounded.
    result_rgb = base_rgb.copy()
    weight_sum = np.zeros((height, width), np.float16)
    conflict_pixels = 0
    seam_total = 0.0
    seam_samples = 0
    metrics = []
    merged_count = 0
    review_tasks = []
    for task in manifest.get("tasks", []):
        edited_path = task.get("editedPatchPath")
        if not edited_path or not os.path.isfile(edited_path):
            continue
        crop = task["crop"]
        x, y, crop_width, crop_height = (int(crop[key]) for key in ("x", "y", "width", "height"))
        if x < 0 or y < 0 or x + crop_width > width or y + crop_height > height:
            raise ValueError(f"Patch {task.get('id')} 的坐标超出原图")
        base_crop = base_rgb[y:y + crop_height, x:x + crop_width]
        edited_rgb, _ = load_rgb(edited_path)
        aligned, alignment_score = align_patch(base_crop, edited_rgb)
        color_matched = match_border_color(base_crop, aligned)
        weight, delta, task_metrics = edit_weight_and_delta(base_crop, color_matched)
        person_weight = task_mask_weight(task, width, height, (x, y, crop_width, crop_height))
        if person_weight is not None:
            weight *= np.clip(person_weight, 0.0, 1.0)
            task_metrics["maskCoverage"] = float(np.mean(person_weight > 0.08))
        if task.get("needsReview"):
            review_tasks.append({"taskId": task.get("id"), "reason": task.get("reviewReason") or "检测结果需要确认"})
        previous_weight = weight_sum[y:y + crop_height, x:x + crop_width].astype(np.float32)
        previous_coverage = np.clip(previous_weight, 0.0, 1.0)
        current_crop = result_rgb[y:y + crop_height, x:x + crop_width].astype(np.float32)
        previous_delta = (current_crop - base_crop.astype(np.float32)) / np.maximum(previous_coverage[..., None], 1e-4)
        overlap = (previous_weight > 0.12) & (weight > 0.12)
        if np.any(overlap):
            disagreement = np.mean(np.abs(previous_delta - delta), axis=2)
            conflict_pixels += int(np.count_nonzero(overlap & (disagreement > 18.0)))
        combined_weight = previous_weight + weight
        combined_delta = (previous_delta * previous_weight[..., None] + delta * weight[..., None]) / np.maximum(combined_weight[..., None], 1e-5)
        combined_coverage = np.clip(combined_weight, 0.0, 1.0)
        result_rgb[y:y + crop_height, x:x + crop_width] = np.clip(
            base_crop.astype(np.float32) + combined_delta * combined_coverage[..., None], 0, 255
        ).astype(np.uint8)
        weight_sum[y:y + crop_height, x:x + crop_width] = combined_weight.astype(np.float16)
        seam_ring = (weight > 0.01) & (weight < 0.22)
        if np.any(seam_ring):
            seam_total += float(np.sum(np.mean(np.abs(delta), axis=2)[seam_ring]))
            seam_samples += int(np.count_nonzero(seam_ring))
        metrics.append({"taskId": task.get("id"), "alignmentScore": alignment_score, **task_metrics})
        merged_count += 1
    if merged_count == 0:
        raise ValueError("尚未上传任何可合并的修图 Patch")
    save_tiff(output_path, result_rgb, metadata)
    seam_score = seam_total / seam_samples if seam_samples else 0.0
    return {
        "success": True,
        "outputPath": output_path,
        "width": width,
        "height": height,
        "mergedCount": merged_count,
        "conflictPixels": conflict_pixels,
        "seamScore": seam_score,
        "needsReview": bool(review_tasks),
        "reviewTasks": review_tasks,
        "metrics": metrics,
    }


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("merge",))
    parser.add_argument("--input", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--output")
    args = parser.parse_args(args_list)
    if not args.manifest or not args.output:
        parser.error("merge requires --manifest and --output")
    result = merge(os.path.abspath(args.input), os.path.abspath(args.manifest), os.path.abspath(args.output))
    emit(result)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    try:
        run(sys.argv[1:])
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
