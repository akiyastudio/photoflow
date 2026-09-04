"""Seam-safe high-resolution Patch recomposition for the team-retouch component."""

from __future__ import annotations

import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import ExifTags, Image, ImageOps


Image.MAX_IMAGE_PIXELS = None


# TIFF's primary IFD also contains image-layout fields such as strip offsets.
# Reusing those fields in a newly encoded TIFF can point outside the new file.
# Keep descriptive fields and rebuild nested EXIF/GPS IFDs instead of copying
# the source TIFF dictionary verbatim.
SAFE_EXIF_TAGS = {
    269,    # DocumentName
    270,    # ImageDescription
    271,    # Make
    272,    # Model
    274,    # Orientation (removed by exif_transpose when necessary)
    282,    # XResolution
    283,    # YResolution
    296,    # ResolutionUnit
    305,    # Software
    306,    # DateTime
    315,    # Artist
    316,    # HostComputer
    33432,  # Copyright
}


def emit(result):
    print(json.dumps(result, ensure_ascii=False), flush=True)


def safe_exif_bytes(image):
    """Serialize portable EXIF fields without source-file offset pointers."""
    try:
        source_exif = image.getexif()
    except Exception:
        return None
    if not source_exif:
        return None

    cleaned = Image.Exif()
    for tag in SAFE_EXIF_TAGS:
        if tag in source_exif:
            cleaned[tag] = source_exif[tag]

    for ifd_tag in (ExifTags.IFD.Exif, ExifTags.IFD.GPSInfo):
        try:
            ifd = source_exif.get_ifd(ifd_tag)
        except Exception:
            continue
        if not ifd:
            continue
        portable_ifd = dict(ifd)
        if ifd_tag == ExifTags.IFD.Exif and ExifTags.IFD.Interop in portable_ifd:
            try:
                portable_ifd[ExifTags.IFD.Interop] = dict(source_exif.get_ifd(ExifTags.IFD.Interop))
            except Exception:
                portable_ifd.pop(ExifTags.IFD.Interop, None)
        cleaned[ifd_tag] = portable_ifd

    if not cleaned:
        return None
    try:
        return cleaned.tobytes()
    except Exception:
        return None


def load_rgb(path):
    with Image.open(path) as source:
        source.load()
        oriented = ImageOps.exif_transpose(source)
        metadata = {
            "icc_profile": source.info.get("icc_profile"),
            "exif": safe_exif_bytes(oriented),
            "dpi": source.info.get("dpi"),
        }
        return np.asarray(oriented.convert("RGB")), metadata


def _masked_mean_absolute_error(left_rgb, right_rgb, mask):
    selected = np.asarray(mask, dtype=bool)
    if not np.any(selected):
        return float("inf")
    difference = np.mean(np.abs(left_rgb.astype(np.float32) - right_rgb.astype(np.float32)), axis=2)
    return float(np.mean(np.minimum(difference[selected], 64.0)))


def align_patch(base_rgb, edited_rgb, person_support=None):
    """Normalize dimensions, then apply only evidence-backed translation.

    Returned files are allowed to have different pixel dimensions, so the
    first resize is mandatory. A second geometric resample is much riskier:
    intended body reshaping can look like registration error, especially on a
    white studio background. Translation is therefore accepted only when
    stable pixels outside the person mask have useful texture and their error
    improves materially.
    """
    height, width = base_rgb.shape[:2]
    returned_height, returned_width = edited_rgb.shape[:2]
    resized = (returned_height, returned_width) != (height, width)
    if resized:
        if returned_height >= height and returned_width >= width:
            interpolation = cv2.INTER_AREA
        elif returned_height <= height and returned_width <= width:
            interpolation = cv2.INTER_CUBIC
        else:
            interpolation = cv2.INTER_LINEAR
        edited_rgb = cv2.resize(edited_rgb, (width, height), interpolation=interpolation)
    diagnostics = {
        "score": 0.0, "resized": resized, "attempted": False, "applied": False,
        "dx": 0.0, "dy": 0.0, "identityError": 0.0,
        "alignedError": 0.0, "reason": "identity",
    }
    scale = min(1.0, 1100.0 / max(height, width))
    base_small = cv2.resize(base_rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else base_rgb
    edit_small = cv2.resize(edited_rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else edited_rgb
    template = cv2.cvtColor(base_small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    moving = cv2.cvtColor(edit_small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    if person_support is None:
        diagnostics["reason"] = "no-person-mask"
        return edited_rgb, diagnostics
    guard_size = max(5, round(min(height, width) * 0.015))
    guard_size += 1 - guard_size % 2
    guard_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (guard_size, guard_size))
    guarded_person = cv2.dilate((np.asarray(person_support, dtype=np.float32) > 0.01).astype(np.uint8), guard_kernel) > 0
    stable_full = ~guarded_person
    edge_margin = max(3, round(min(height, width) * 0.015))
    stable_full[:edge_margin] = False
    stable_full[-edge_margin:] = False
    stable_full[:, :edge_margin] = False
    stable_full[:, -edge_margin:] = False
    stable_small = cv2.resize(stable_full.astype(np.uint8), (template.shape[1], template.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    minimum_pixels = max(256, round(stable_small.size * 0.008))
    if int(np.count_nonzero(stable_small)) < minimum_pixels:
        diagnostics["reason"] = "insufficient-background"
        return edited_rgb, diagnostics
    gradient_x = cv2.Sobel(template, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(template, cv2.CV_32F, 0, 1, ksize=3)
    textured = np.hypot(gradient_x, gradient_y) > 0.025
    texture_fraction = float(np.mean(textured[stable_small]))
    diagnostics["textureFraction"] = texture_fraction
    occupied_cells = 0
    for row in range(4):
        for column in range(4):
            y1, y2 = row * template.shape[0] // 4, (row + 1) * template.shape[0] // 4
            x1, x2 = column * template.shape[1] // 4, (column + 1) * template.shape[1] // 4
            cell_stable = stable_small[y1:y2, x1:x2]
            cell_texture = textured[y1:y2, x1:x2] & cell_stable
            if np.count_nonzero(cell_texture) >= max(8, round(cell_stable.size * 0.003)):
                occupied_cells += 1
    diagnostics["textureCells"] = occupied_cells
    if texture_fraction < 0.006 or occupied_cells < 3:
        diagnostics["reason"] = "low-texture-background"
        return edited_rgb, diagnostics
    identity_error = _masked_mean_absolute_error(base_rgb, edited_rgb, stable_full)
    diagnostics["identityError"] = identity_error
    diagnostics["alignedError"] = identity_error
    if identity_error < 1.25:
        diagnostics["reason"] = "background-already-aligned"
        return edited_rgb, diagnostics
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        diagnostics["attempted"] = True
        score, warp = cv2.findTransformECC(
            template, moving, warp, cv2.MOTION_TRANSLATION,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5),
            stable_small.astype(np.uint8) * 255, 3,
        )
        warp[:, 2] /= scale
        proposed_dx, proposed_dy = float(warp[0, 2]), float(warp[1, 2])
        dx, dy = int(round(proposed_dx)), int(round(proposed_dy))
        diagnostics.update({
            "score": float(score), "proposedDx": proposed_dx, "proposedDy": proposed_dy,
            "dx": float(dx), "dy": float(dy),
        })
        shift = float(np.hypot(dx, dy))
        maximum_shift = max(2.0, min(12.0, min(height, width) * 0.006))
        if dx == 0 and dy == 0:
            diagnostics["reason"] = "subpixel-translation-rejected"
            return edited_rgb, diagnostics
        if shift > maximum_shift:
            diagnostics["reason"] = "translation-out-of-range"
            return edited_rgb, diagnostics
        candidate = cv2.warpAffine(
            edited_rgb, np.asarray([[1.0, 0.0, dx], [0.0, 1.0, dy]], dtype=np.float32), (width, height),
            flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        aligned_error = _masked_mean_absolute_error(base_rgb, candidate, stable_full)
        diagnostics["alignedError"] = aligned_error
        required_improvement = max(0.75, identity_error * 0.12)
        if float(score) < 0.90 or identity_error - aligned_error < required_improvement:
            diagnostics["reason"] = "insufficient-improvement"
            return edited_rgb, diagnostics
        diagnostics.update({"applied": True, "reason": "background-translation"})
        return candidate, diagnostics
    except cv2.error:
        diagnostics.update({"score": 0.0, "reason": "ecc-failed"})
        return edited_rgb, diagnostics


def border_mask(height, width, fraction=0.12):
    y, x = np.ogrid[:height, :width]
    distance = np.minimum.reduce((x + np.zeros_like(y), width - 1 - x + np.zeros_like(y),
                                  y + np.zeros_like(x), height - 1 - y + np.zeros_like(x))).astype(np.float32)
    feather = max(24.0, min(height, width) * fraction)
    normalized = np.clip(distance / feather, 0.0, 1.0)
    return normalized * normalized * (3.0 - 2.0 * normalized)


def match_border_color(base_rgb, edited_rgb, person_support=None):
    height, width = base_rgb.shape[:2]
    ring = border_mask(height, width, 0.14) < 0.58
    if person_support is not None:
        ring &= np.asarray(person_support, dtype=np.float32) < 0.05
    minimum_pixels = max(512, round(height * width * 0.005))
    diagnostics = {"applied": False, "beforeError": 0.0, "afterError": 0.0}
    if int(np.count_nonzero(ring)) < minimum_pixels:
        diagnostics["reason"] = "insufficient-stable-background"
        return edited_rgb, diagnostics
    base_lab = cv2.cvtColor(base_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    edit_lab = cv2.cvtColor(edited_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    adjusted = edit_lab.copy()
    for channel in range(3):
        base_values = base_lab[..., channel][ring]
        edit_values = edit_lab[..., channel][ring]
        base_median, edit_median = float(np.median(base_values)), float(np.median(edit_values))
        base_spread = float(np.percentile(base_values, 75) - np.percentile(base_values, 25))
        edit_spread = max(1.0, float(np.percentile(edit_values, 75) - np.percentile(edit_values, 25)))
        channel_scale = float(np.clip(base_spread / edit_spread, 0.94, 1.06))
        offset = float(np.clip(base_median - edit_median, -18.0, 18.0))
        adjusted[..., channel] = (adjusted[..., channel] - edit_median) * channel_scale + edit_median + offset
    candidate = cv2.cvtColor(np.clip(adjusted, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)
    before_error = _masked_mean_absolute_error(base_rgb, edited_rgb, ring)
    after_error = _masked_mean_absolute_error(base_rgb, candidate, ring)
    diagnostics.update({"beforeError": before_error, "afterError": after_error})
    if before_error >= 2.0 and before_error - after_error >= max(1.0, before_error * 0.20):
        diagnostics.update({"applied": True, "reason": "stable-background-improved"})
        return candidate, diagnostics
    diagnostics["reason"] = "insufficient-improvement"
    return edited_rgb, diagnostics


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
    edit_support = np.maximum(strength, soft_changed * 0.72)
    weight = border_mask(base_rgb.shape[0], base_rgb.shape[1]) * edit_support
    # Preserve source texture only where the returned patch is effectively
    # unchanged. Re-injecting source detail at a moved silhouette produces a
    # faint copy of the old edge, which reads as ghosting after recomposition.
    original_detail = base_float - base_low
    unchanged = 1.0 - np.clip(edit_support[..., None] / 0.28, 0.0, 1.0)
    detail_factor = 0.48 * unchanged * unchanged
    enhanced = np.clip(edit_float + original_detail * detail_factor, 0, 255)
    return weight.astype(np.float32), enhanced - base_float, {"noise": noise, "threshold": threshold}


def fuse_patch_delta(base_rgb, current_rgb, previous_confidence, weight, delta):
    """Fuse one crop without averaging visibly different overlapping edges.

    Low-disagreement pixels may be blended safely. At a conflicting overlap we
    choose one patch with a spatially smoothed confidence decision, so two
    independently aligned silhouettes never become a semi-transparent double
    edge. Ties intentionally prefer the later task: relay returns contain the
    work of their predecessors and are therefore the more complete source.
    """
    base_float = base_rgb.astype(np.float32)
    current_float = current_rgb.astype(np.float32)
    previous = np.clip(previous_confidence.astype(np.float32), 0.0, 1.0)
    candidate = np.clip(weight.astype(np.float32), 0.0, 1.0)
    previous_delta = (current_float - base_float) / np.maximum(previous[..., None], 1e-4)

    overlap = (previous > 0.12) & (candidate > 0.12)
    disagreement = np.mean(np.abs(previous_delta - delta), axis=2)
    # Even a modest per-channel mismatch can reveal a second contour on smooth
    # clothing or skin. Use the lower threshold for source selection, while
    # retaining the historical 18-level threshold for the review metric.
    discordant = overlap & (disagreement > 8.0)
    severe_conflict = overlap & (disagreement > 18.0)

    combined_confidence = np.maximum(previous, candidate)
    combined_delta = (
        previous_delta * previous[..., None] + delta * candidate[..., None]
    ) / np.maximum((previous + candidate)[..., None], 1e-5)

    if np.any(discordant):
        sigma = max(1.5, min(base_rgb.shape[:2]) * 0.002)
        confidence_margin = cv2.GaussianBlur(candidate - previous, (0, 0), sigma)
        current_wins = discordant & (confidence_margin >= 0.0)
        previous_wins = discordant & ~current_wins
        combined_delta[current_wins] = delta[current_wins]
        combined_confidence[current_wins] = candidate[current_wins]
        combined_delta[previous_wins] = previous_delta[previous_wins]
        combined_confidence[previous_wins] = previous[previous_wins]

    fused = np.clip(
        base_float + combined_delta * combined_confidence[..., None], 0, 255
    ).astype(np.uint8)
    return fused, combined_confidence.astype(np.float16), int(np.count_nonzero(severe_conflict))


def task_mask_weights(task, image_width, image_height, crop):
    """Return core and outer-support person masks in crop coordinates.

    Detection masks are stored as full-image proxy PNGs.  The work patch stays
    rectangular and contains all context. The core owns the detected person;
    the narrower support band permits genuine silhouette edits without giving
    ordinary background differences permission to create a halo.
    """
    mask_path = task.get("maskPath")
    if not mask_path or not os.path.isfile(mask_path):
        raise ValueError(f"Patch {task.get('id')} 缺少可信人物遮罩，已拒绝合并")
    try:
        with Image.open(mask_path) as source:
            source.load()
            full_proxy = np.asarray(source.convert("L"))
    except (OSError, ValueError) as error:
        raise ValueError(f"Patch {task.get('id')} 的人物遮罩损坏，已拒绝合并") from error
    if full_proxy.ndim != 2 or not full_proxy.size or not np.any(full_proxy > 0):
        raise ValueError(f"Patch {task.get('id')} 的人物遮罩为空，已拒绝合并")
    x, y, crop_width, crop_height = crop
    proxy_height, proxy_width = full_proxy.shape[:2]
    scale_x = proxy_width / image_width
    scale_y = proxy_height / image_height
    left = max(0, min(proxy_width - 1, int(np.floor(x * scale_x))))
    top = max(0, min(proxy_height - 1, int(np.floor(y * scale_y))))
    right = max(left + 1, min(proxy_width, int(np.ceil((x + crop_width) * scale_x))))
    bottom = max(top + 1, min(proxy_height, int(np.ceil((y + crop_height) * scale_y))))
    proxy_crop = full_proxy[top:bottom, left:right]
    if not proxy_crop.size or not np.any(proxy_crop > 0):
        raise ValueError(f"Patch {task.get('id')} 的人物遮罩与工作图不相交，已拒绝合并")
    target = cv2.resize(proxy_crop, (crop_width, crop_height), interpolation=cv2.INTER_LINEAR) / 255.0
    core = cv2.GaussianBlur(np.clip(target.astype(np.float32), 0.0, 1.0), (0, 0), 1.0)
    kernel_size = max(7, int(min(crop_height, crop_width) * 0.006))
    kernel_size += 1 - kernel_size % 2
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    expanded = cv2.dilate((target > 0.20).astype(np.uint8), kernel).astype(np.float32)
    support = cv2.GaussianBlur(expanded, (0, 0), max(2.0, kernel_size * 0.28))
    return np.clip(core, 0.0, 1.0), np.clip(support, 0.0, 1.0)


def constrain_person_boundary(weight, delta, core, support):
    """Reject background drift and make real high-contrast moves opaque.

    A soft alpha is useful for tiny tonal differences, but it is destructive
    where a dark silhouette moves over a light background: partial coverage
    creates a gray copy of the old contour. Strong changes connected to the
    person support therefore select the returned patch completely.
    """
    magnitude = np.mean(np.abs(delta), axis=2)
    evidence = np.clip((magnitude - 32.0) / 64.0, 0.0, 1.0)
    evidence = evidence * evidence * (3.0 - 2.0 * evidence)
    allowed = np.maximum(core, support * evidence)
    protected = weight * np.clip(allowed, 0.0, 1.0)
    detected_change = weight > 0.08
    opaque_core = detected_change & (core > 0.80) & (magnitude >= 32.0)
    opaque_boundary = detected_change & (support > 0.08) & (magnitude >= 56.0)
    protected[opaque_core | opaque_boundary] = 1.0
    return protected


def save_tiff(path, rgb, metadata):
    options = {"format": "TIFF", "compression": "tiff_deflate"}
    if metadata.get("icc_profile"):
        options["icc_profile"] = metadata["icc_profile"]
    if metadata.get("exif"):
        options["exif"] = metadata["exif"]
    if metadata.get("dpi"):
        options["dpi"] = metadata["dpi"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    image = Image.fromarray(rgb.astype(np.uint8), "RGB")
    try:
        image.save(path, **options)
    except Exception:
        if "exif" not in options:
            raise
        # Pixel output, ICC and DPI are more important than a malformed EXIF
        # block. Remove a partial TIFF and retry without EXIF only.
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        fallback_options = {key: value for key, value in options.items() if key != "exif"}
        image.save(path, **fallback_options)


def merge(input_path, manifest_path, output_path):
    base_rgb, metadata = load_rgb(input_path)
    with open(manifest_path, "r", encoding="utf-8") as source:
        manifest = json.load(source)
    height, width = base_rgb.shape[:2]
    # Keep only an 8-bit working image plus a half-float confidence map. A full
    # high-resolution float RGB accumulator would exceed 1 GB once temporary
    # arrays are included; crop-local updates keep memory bounded.
    result_rgb = base_rgb.copy()
    confidence_map = np.zeros((height, width), np.float16)
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
        returned_height, returned_width = edited_rgb.shape[:2]
        aspect_delta = abs(np.log(max(1e-6, (returned_width / max(1, returned_height)) / (crop_width / max(1, crop_height)))))
        dimension_scale = float(np.sqrt((returned_width * returned_height) / max(1, crop_width * crop_height)))
        exact_same = edited_rgb.shape == base_crop.shape and np.array_equal(edited_rgb, base_crop)
        warnings = []
        if exact_same:
            warnings.append("返图与原始工作图完全相同")
        if aspect_delta > 0.08:
            warnings.append("返图长宽比与工作图异常不一致")
        if dimension_scale < 0.35 or dimension_scale > 2.5:
            warnings.append("返图尺寸与工作图比例异常")
        if (returned_width, returned_height) == (width, height) and (crop_width, crop_height) != (width, height):
            warnings.append("疑似误传整张原图")
        person_core, person_support = task_mask_weights(task, width, height, (x, y, crop_width, crop_height))
        aligned, alignment = align_patch(base_crop, edited_rgb, person_support)
        color_matched, color_match = match_border_color(base_crop, aligned, person_support)
        weight, delta, task_metrics = edit_weight_and_delta(base_crop, color_matched)
        changed_fraction = float(np.mean(weight > 0.08))
        mean_delta = float(np.mean(np.abs(delta)))
        if not exact_same and changed_fraction < 0.0005:
            warnings.append("有效修改面积过小，修改证据不足")
        task_metrics.update({
            "returnedWidth": returned_width, "returnedHeight": returned_height,
            "aspectRatioDelta": float(aspect_delta), "dimensionScale": dimension_scale, "exactSame": bool(exact_same),
            "changedFraction": changed_fraction, "meanAbsoluteDelta": mean_delta,
            "returnWarnings": warnings, "resized": bool(alignment.get("resized")),
            "alignmentAttempted": bool(alignment.get("attempted")),
            "alignmentApplied": bool(alignment.get("applied")),
            "alignmentDx": float(alignment.get("dx", 0.0)), "alignmentDy": float(alignment.get("dy", 0.0)),
            "alignmentReason": str(alignment.get("reason") or ""),
            "alignmentIdentityError": float(alignment.get("identityError", 0.0)),
            "alignmentResultError": float(alignment.get("alignedError", 0.0)),
            "colorMatchApplied": bool(color_match.get("applied")),
            "colorMatchBeforeError": float(color_match.get("beforeError", 0.0)),
            "colorMatchAfterError": float(color_match.get("afterError", 0.0)),
        })
        if person_core is not None:
            weight = constrain_person_boundary(weight, delta, person_core, person_support)
            task_metrics["maskCoverage"] = float(np.mean(person_support > 0.08))
        if task.get("needsReview"):
            review_tasks.append({"taskId": task.get("id"), "reason": task.get("reviewReason") or "检测结果需要确认"})
        if warnings:
            review_tasks.append({"taskId": task.get("id"), "reason": "；".join(warnings), "returnWarnings": warnings})
        confidence_crop = confidence_map[y:y + crop_height, x:x + crop_width]
        current_crop = result_rgb[y:y + crop_height, x:x + crop_width]
        fused_crop, fused_confidence, task_conflicts = fuse_patch_delta(
            base_crop, current_crop, confidence_crop, weight, delta
        )
        result_rgb[y:y + crop_height, x:x + crop_width] = fused_crop
        confidence_map[y:y + crop_height, x:x + crop_width] = fused_confidence
        conflict_pixels += task_conflicts
        seam_ring = (weight > 0.01) & (weight < 0.22)
        if np.any(seam_ring):
            seam_total += float(np.sum(np.mean(np.abs(delta), axis=2)[seam_ring]))
            seam_samples += int(np.count_nonzero(seam_ring))
        metrics.append({"taskId": task.get("id"), "alignmentScore": float(alignment.get("score", 0.0)), **task_metrics})
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
        "qualityGate": {"passed": not bool(review_tasks), "reviewTaskCount": len(review_tasks)},
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
