"""PhotoFlow multi-person retouch engine.

RTMDet supplies the stable person set.  When the optional WSL CUDA runtime is
available, PairDETR corrects body boxes and SAM 2.1 supplies fine instance
masks. Nearby people share adaptive 2:3 or 3:2 context tiles; this is not a
person cut-out workflow.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import os
import sys
import uuid
from pathlib import Path

# Installation probes only need the standard library and advanced_bridge.  Do
# not pay the OpenCV/NumPy/ONNX import cost before deciding which action runs.
_LIGHTWEIGHT_ACTIONS = {"probe-advanced-installation", "probe-advanced-runtime"}
_LIGHTWEIGHT_STARTUP = len(sys.argv) > 1 and sys.argv[1] in _LIGHTWEIGHT_ACTIONS
if not _LIGHTWEIGHT_STARTUP:
    import cv2
    import numpy as np
    from PIL import Image, ImageOps
    from identity_engine import CompactPairMetrics, IdentityRuntime, add_occlusion_estimates, constrained_clusters, ranked_similarity_pairs
    Image.MAX_IMAGE_PIXELS = None

RTMDET_INPUT_SIZE = 640
RTMDET_SCORE_THRESHOLD = 0.45
PAIRDETR_LOW_THRESHOLD = 0.20
PAIRDETR_EXTRA_THRESHOLD = 0.50
PAIR_MATCH_IOU = 0.15
WORK_TILE_EDGE = 4000
MIN_WORK_TILE_EDGE = 2800
MAX_PEOPLE_PER_TILE = 4
MASK_PROXY_EDGE = 4096
RTMDET_MODEL_NAME = "rtmdet-ins_m_640x640.onnx"
PROGRESS_CONTEXT = {}


def emit(result):
    print(json.dumps(result, ensure_ascii=False), flush=True)


def emit_progress(progress, message):
    payload = {
        "type": "progress", "progress": max(0, min(100, int(progress))),
        "message": str(message), **PROGRESS_CONTEXT,
    }
    emit(payload)


def component_directory():
    return Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent


def asset_path(*parts):
    candidates = [component_directory().joinpath(*parts)]
    if hasattr(sys, "_MEIPASS"):
        candidates.append(Path(sys._MEIPASS).joinpath(*parts))
    candidates.append(Path(__file__).resolve().parent.joinpath(*parts))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"团片协作模型或脚本不存在：{candidates[0]}")


def model_path(name=RTMDET_MODEL_NAME):
    path = asset_path("models", name)
    if path.stat().st_size < 1024 * 1024:
        prefix = path.read_bytes()[:256]
        if prefix.startswith(b"version https://git-lfs.github.com/spec/v1"):
            raise RuntimeError("人物检测模型尚未通过 Git LFS 下载，请在项目目录执行 git lfs pull 后重试")
        raise RuntimeError(f"人物检测模型不完整：{path.name}（仅 {path.stat().st_size} 字节）")
    return path


def advanced_fallback_reason(error):
    detail = str(error)
    normalized = detail.upper()
    unavailable_markers = (
        "WSL_E_DISTRO_NOT_FOUND", "HCS/ERROR_PATH_NOT_FOUND",
        "HCS_E_PATH_NOT_FOUND", "E_ACCESSDENIED",
        "高级后端不可用", "高级后端未安装",
    )
    if any(marker.upper() in normalized for marker in unavailable_markers):
        return "高级后端未安装，已使用 RTMDet"
    compact = " ".join(detail.split())
    return f"高级后端异常，已使用 RTMDet：{compact[-240:]}"


def create_session(preference="auto"):
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError("人物检测组件缺少 ONNX Runtime 运行库（onnxruntime-directml）") from error
    providers = ort.get_available_providers()
    options = ort.SessionOptions()
    if preference != "cpu" and "DmlExecutionProvider" in providers:
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        try:
            session = ort.InferenceSession(
                str(model_path()), sess_options=options,
                providers=["DmlExecutionProvider", "CPUExecutionProvider"],
            )
            return session, providers, "gpu"
        except Exception:
            if preference == "gpu":
                raise
    elif preference == "gpu":
        raise RuntimeError(f"DirectML GPU 不可用；当前运行库提供：{', '.join(providers) or '无'}")
    if "CPUExecutionProvider" not in providers:
        raise RuntimeError(f"ONNX CPU 执行器不可用；当前运行库提供：{', '.join(providers) or '无'}")
    session = ort.InferenceSession(str(model_path()), providers=["CPUExecutionProvider"])
    return session, providers, "cpu"


def load_rgb(path):
    with Image.open(path) as source:
        source.load()
        return np.asarray(ImageOps.exif_transpose(source).convert("RGB"))


def load_mask(path):
    with Image.open(path) as source:
        source.load()
        return np.asarray(source.convert("L"))


def save_mask(path, mask):
    Image.fromarray((np.asarray(mask) > 0).astype(np.uint8) * 255, "L").save(
        path, format="PNG", compress_level=3
    )


def letterbox_bgr(rgb):
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    height, width = bgr.shape[:2]
    scale = min(RTMDET_INPUT_SIZE / width, RTMDET_INPUT_SIZE / height)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    resized = cv2.resize(bgr, (resized_width, resized_height), interpolation=cv2.INTER_AREA)
    canvas = np.full((RTMDET_INPUT_SIZE, RTMDET_INPUT_SIZE, 3), 114, dtype=np.uint8)
    canvas[:resized_height, :resized_width] = resized
    mean = np.asarray([103.53, 116.28, 123.675], dtype=np.float32)
    std = np.asarray([57.375, 57.12, 58.395], dtype=np.float32)
    tensor = (canvas.astype(np.float32) - mean) / std
    return np.ascontiguousarray(tensor.transpose(2, 0, 1)[None]), scale, resized_width, resized_height


def proxy_size(width, height):
    scale = min(1.0, MASK_PROXY_EDGE / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale)), scale


def infer_rtmdet(session, rgb):
    height, width = rgb.shape[:2]
    tensor, scale, valid_width, valid_height = letterbox_bgr(rgb)
    outputs = session.run(None, {session.get_inputs()[0].name: tensor})
    by_name = dict(zip((item.name for item in session.get_outputs()), outputs))
    dets = by_name["dets"][0]
    labels = by_name["labels"][0]
    masks = by_name["masks"][0]
    people = (dets[:, 4] >= RTMDET_SCORE_THRESHOLD) & (labels == 0)
    selected_dets = dets[people]
    selected_masks = masks[people]
    proxy_width, proxy_height, _ = proxy_size(width, height)
    detections = []
    for detection, raw_mask in zip(selected_dets, selected_masks):
        x1, y1, x2, y2 = detection[:4] / scale
        box = [
            float(np.clip(x1, 0, width - 1)), float(np.clip(y1, 0, height - 1)),
            float(np.clip(x2, 0, width - 1)), float(np.clip(y2, 0, height - 1)),
        ]
        valid_mask = np.asarray(raw_mask[:valid_height, :valid_width]) >= 0.5
        mask_proxy = cv2.resize(
            valid_mask.astype(np.uint8), (proxy_width, proxy_height), interpolation=cv2.INTER_NEAREST
        ) > 0
        detections.append({"box": box, "score": float(detection[4]), "mask": mask_proxy})
    detections.sort(key=lambda item: ((item["box"][1] + item["box"][3]) / 2, (item["box"][0] + item["box"][2]) / 2))
    return detections


def box_iou(left, right):
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0


def box_overlap_over_smaller(left, right):
    """Return intersection over the smaller box, useful for nested detections."""
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    smaller_area = min(left_area, right_area)
    return intersection / smaller_area if smaller_area else 0.0


def normalized_box_center_distance(left, right):
    left_center = ((left[0] + left[2]) / 2, (left[1] + left[3]) / 2)
    right_center = ((right[0] + right[2]) / 2, (right[1] + right[3]) / 2)
    left_diagonal = math.hypot(left[2] - left[0], left[3] - left[1])
    right_diagonal = math.hypot(right[2] - right[0], right[3] - right[1])
    return math.hypot(left_center[0] - right_center[0], left_center[1] - right_center[1]) / max(1.0, min(left_diagonal, right_diagonal))


def same_face_detection(left, right):
    """Detect two PairDETR results anchored to the same face.

    Body boxes legitimately overlap in crowds, so face evidence is deliberately
    required unless the body boxes are almost identical.
    """
    left_face = left.get("face_box_xyxy") or left.get("faceBox")
    right_face = right.get("face_box_xyxy") or right.get("faceBox")
    if not left_face or not right_face:
        return False
    overlap = box_iou(left_face, right_face)
    containment = box_overlap_over_smaller(left_face, right_face)
    center_distance = normalized_box_center_distance(left_face, right_face)
    return overlap >= 0.38 or containment >= 0.68 or (containment >= 0.45 and center_distance <= 0.22)


def duplicate_person_detection(left, right, left_box_key="box", right_box_key="box"):
    left_box, right_box = left[left_box_key], right[right_box_key]
    overlap = box_iou(left_box, right_box)
    containment = box_overlap_over_smaller(left_box, right_box)
    center_distance = normalized_box_center_distance(left_box, right_box)
    if same_face_detection(left, right):
        return overlap >= 0.10 or containment >= 0.38
    # Body-only detections need much stronger geometry. This preserves two
    # genuinely occluded people whose broad body boxes happen to intersect.
    return overlap >= 0.84 or (containment >= 0.92 and center_distance <= 0.16)


def mask_overlap_scores(left, right):
    left_mask, right_mask = left.get("mask"), right.get("mask")
    if left_mask is None or right_mask is None:
        return 0.0, 0.0
    left_mask, right_mask = np.asarray(left_mask) > 0, np.asarray(right_mask) > 0
    if left_mask.shape != right_mask.shape or not left_mask.size:
        return 0.0, 0.0
    intersection = int(np.logical_and(left_mask, right_mask).sum())
    left_area, right_area = int(left_mask.sum()), int(right_mask.sum())
    union = left_area + right_area - intersection
    smaller_area = min(left_area, right_area)
    return (
        intersection / union if union else 0.0,
        intersection / smaller_area if smaller_area else 0.0,
    )


def suppress_rtmdet_duplicates(rtmdet):
    """Use instance masks to remove duplicate RTMDet boxes safely in crowds."""
    kept = []
    for original_index, item in sorted(enumerate(rtmdet), key=lambda value: float(value[1].get("score", 0)), reverse=True):
        duplicate = False
        for _kept_index, existing in kept:
            mask_iou, mask_containment = mask_overlap_scores(item, existing)
            body_iou = box_iou(item["box"], existing["box"])
            body_containment = box_overlap_over_smaller(item["box"], existing["box"])
            if ((mask_iou >= 0.58 or mask_containment >= 0.82)
                    and (body_iou >= 0.20 or body_containment >= 0.52)):
                duplicate = True
                break
        if not duplicate:
            kept.append((original_index, item))
    return kept


def suppress_pair_duplicates(pair_boxes):
    """Collapse duplicate PairDETR queries without ordinary crowd-damaging NMS."""
    kept = []
    for pair in sorted(pair_boxes, key=lambda item: float(item.get("pair_score", 0)), reverse=True):
        if any(duplicate_person_detection(pair, existing, "box_xyxy", "box_xyxy") for existing in kept):
            continue
        kept.append(pair)
    return kept


def exclusion_xyxy(value):
    if not isinstance(value, dict):
        return None
    x = float(value.get("x", 0))
    y = float(value.get("y", 0))
    width = float(value.get("width", 0))
    height = float(value.get("height", 0))
    if x < 0 or y < 0 or width <= 0 or height <= 0:
        return None
    return [x, y, x + width, y + height]


def matches_exclusion(box, exclusion):
    overlap = box_iou(box, exclusion)
    if overlap >= 0.45:
        return True
    intersection_width = max(0.0, min(box[2], exclusion[2]) - max(box[0], exclusion[0]))
    intersection_height = max(0.0, min(box[3], exclusion[3]) - max(box[1], exclusion[1]))
    intersection = intersection_width * intersection_height
    smaller_area = min(
        max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1]),
        max(0.0, exclusion[2] - exclusion[0]) * max(0.0, exclusion[3] - exclusion[1]),
    )
    return smaller_area > 0 and intersection / smaller_area >= 0.72


def excluded_detection_indices(items, exclusions):
    """Match each saved exclusion to at most one newly detected person."""
    candidates = []
    for exclusion_index, exclusion in enumerate(exclusions):
        exclusion_center = ((exclusion[0] + exclusion[2]) / 2, (exclusion[1] + exclusion[3]) / 2)
        exclusion_diagonal = max(1.0, math.hypot(exclusion[2] - exclusion[0], exclusion[3] - exclusion[1]))
        for person_index, item in enumerate(items):
            box = item["box"]
            if not matches_exclusion(box, exclusion):
                continue
            overlap = box_iou(box, exclusion)
            person_center = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            center_distance = math.hypot(person_center[0] - exclusion_center[0], person_center[1] - exclusion_center[1]) / exclusion_diagonal
            candidates.append((overlap, -center_distance, exclusion_index, person_index))
    matched_exclusions = set()
    matched_people = set()
    for _overlap, _center_distance, exclusion_index, person_index in sorted(candidates, reverse=True):
        if exclusion_index in matched_exclusions or person_index in matched_people:
            continue
        matched_exclusions.add(exclusion_index)
        matched_people.add(person_index)
    return matched_people


def fuse_boxes(rtmdet, pair_boxes):
    rtmdet_with_indices = suppress_rtmdet_duplicates(rtmdet)
    pair_boxes = suppress_pair_duplicates(pair_boxes)
    candidates = []
    for rtmdet_slot, (_original_index, baseline) in enumerate(rtmdet_with_indices):
        for pair_index, pair in enumerate(pair_boxes):
            overlap = box_iou(baseline["box"], pair["box_xyxy"])
            containment = box_overlap_over_smaller(baseline["box"], pair["box_xyxy"])
            center_distance = normalized_box_center_distance(baseline["box"], pair["box_xyxy"])
            if overlap >= PAIR_MATCH_IOU or (containment >= 0.48 and center_distance <= 0.34):
                size_similarity = min(
                    max(1.0, (baseline["box"][2] - baseline["box"][0]) * (baseline["box"][3] - baseline["box"][1])),
                    max(1.0, (pair["box_xyxy"][2] - pair["box_xyxy"][0]) * (pair["box_xyxy"][3] - pair["box_xyxy"][1])),
                ) / max(
                    max(1.0, (baseline["box"][2] - baseline["box"][0]) * (baseline["box"][3] - baseline["box"][1])),
                    max(1.0, (pair["box_xyxy"][2] - pair["box_xyxy"][0]) * (pair["box_xyxy"][3] - pair["box_xyxy"][1])),
                )
                score = 0.55 * overlap + 0.24 * containment + 0.13 * max(0.0, 1.0 - center_distance) + 0.08 * size_similarity
                candidates.append((score, overlap, rtmdet_slot, pair_index))
    matched_rtmdet, matched_pair, matches = set(), set(), {}
    for _score, overlap, rtmdet_index, pair_index in sorted(candidates, reverse=True):
        if rtmdet_index in matched_rtmdet or pair_index in matched_pair:
            continue
        matched_rtmdet.add(rtmdet_index)
        matched_pair.add(pair_index)
        matches[rtmdet_index] = (pair_index, overlap)

    fused = []
    for rtmdet_slot, (original_index, baseline) in enumerate(rtmdet_with_indices):
        if rtmdet_slot in matches:
            pair_index, overlap = matches[rtmdet_slot]
            pair = pair_boxes[pair_index]
            fused.append({
                "box": pair["box_xyxy"], "score": pair["pair_score"],
                "faceBox": pair.get("face_box_xyxy"),
                "source": "pairdetr-matched", "rtmdetIndex": original_index,
                "matchIou": overlap,
            })
        else:
            fused.append({
                "box": baseline["box"], "score": baseline["score"],
                "faceBox": None, "source": "rtmdet-fallback",
                "rtmdetIndex": original_index,
                "matchIou": 0.0,
            })
    for pair_index, pair in enumerate(pair_boxes):
        if pair_index not in matched_pair and float(pair["pair_score"]) >= PAIRDETR_EXTRA_THRESHOLD:
            fused.append({
                "box": pair["box_xyxy"], "score": pair["pair_score"],
                "faceBox": pair.get("face_box_xyxy"),
                "source": "pairdetr-extra", "rtmdetIndex": None, "matchIou": 0.0,
            })
    deduplicated = []
    for item in fused:
        if any(duplicate_person_detection(item, existing) for existing in deduplicated):
            continue
        deduplicated.append(item)
    deduplicated.sort(key=lambda item: ((item["box"][1] + item["box"][3]) / 2, (item["box"][0] + item["box"][2]) / 2))
    return deduplicated


def fill_mask_holes(mask):
    binary = (mask > 0).astype(np.uint8)
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
    padded = cv2.copyMakeBorder(closed, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    flood = padded.copy()
    cv2.floodFill(flood, None, (0, 0), 1)
    holes = (flood[1:-1, 1:-1] == 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(holes, 8)
    maximum_hole = max(256, round(binary.size * 0.0025))
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] <= maximum_hole:
            closed[labels == label] = 1
    return closed > 0


def combine_masks(sam_mask, rtmdet_mask):
    sam = fill_mask_holes(sam_mask)
    if rtmdet_mask is None:
        return sam
    if rtmdet_mask.shape != sam.shape:
        rtmdet_mask = cv2.resize(rtmdet_mask.astype(np.uint8), (sam.shape[1], sam.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    radius = max(9, round(min(sam.shape) * 0.008))
    radius += 1 - radius % 2
    nearby = cv2.dilate(sam.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius, radius))) > 0
    return fill_mask_holes(sam | (rtmdet_mask & nearby))


def union_box(boxes):
    return [
        min(float(box[0]) for box in boxes), min(float(box[1]) for box in boxes),
        max(float(box[2]) for box in boxes), max(float(box[3]) for box in boxes),
    ]


def clamp_box(box, image_width, image_height):
    return [
        float(np.clip(box[0], 0, max(0, image_width - 1))),
        float(np.clip(box[1], 0, max(0, image_height - 1))),
        float(np.clip(box[2], 0, max(0, image_width - 1))),
        float(np.clip(box[3], 0, max(0, image_height - 1))),
    ]


def _place_crop(box, crop_width, crop_height, image_width, image_height):
    """Center a crop while guaranteeing that the complete hard box stays inside."""
    crop_width = max(1, min(int(round(crop_width)), int(image_width)))
    crop_height = max(1, min(int(round(crop_height)), int(image_height)))
    center_x = (float(box[0]) + float(box[2])) / 2
    center_y = (float(box[1]) + float(box[3])) / 2
    minimum_left = max(0, int(math.ceil(float(box[2]) - crop_width)))
    maximum_left = min(int(math.floor(float(box[0]))), int(image_width) - crop_width)
    minimum_top = max(0, int(math.ceil(float(box[3]) - crop_height)))
    maximum_top = min(int(math.floor(float(box[1]))), int(image_height) - crop_height)
    if minimum_left > maximum_left or minimum_top > maximum_top:
        return None
    left = max(minimum_left, min(int(round(center_x - crop_width / 2)), maximum_left))
    top = max(minimum_top, min(int(round(center_y - crop_height / 2)), maximum_top))
    return [left, top, crop_width, crop_height]


def expanded_planning_box(box, image_width, image_height, margin_ratio=0.08):
    box_width = max(1.0, float(box[2]) - float(box[0]))
    box_height = max(1.0, float(box[3]) - float(box[1]))
    margin_x = max(80.0, box_width * margin_ratio)
    margin_y = max(80.0, box_height * margin_ratio)
    return [
        max(0.0, float(box[0]) - margin_x),
        max(0.0, float(box[1]) - margin_y),
        min(float(image_width), float(box[2]) + margin_x),
        min(float(image_height), float(box[3]) + margin_y),
    ]


def planned_work_crop(box, image_width, image_height, edge=WORK_TILE_EDGE, allow_oversize=True,
                      margin_ratio=0.08, prefer_edge_fill=False):
    """Return an adaptive phone-friendly crop containing a complete person/group.

    Normal work images use at most ``edge`` pixels on their longest side. If a
    single person's detected body cannot fit, the crop grows beyond that limit
    instead of cutting the person off.
    """
    padded_box = expanded_planning_box(box, image_width, image_height, margin_ratio)
    desired_width = max(1.0, padded_box[2] - padded_box[0])
    desired_height = max(1.0, padded_box[3] - padded_box[1])
    box_aspect = desired_width / desired_height
    candidates = []
    for ratio_width, ratio_height in ((2, 3), (3, 2), (1, 2), (2, 1), (1, 1)):
        required_scale = max(desired_width / ratio_width, desired_height / ratio_height)
        maximum_scale = min(
            float(edge) / max(ratio_width, ratio_height),
            float(image_width) / ratio_width,
            float(image_height) / ratio_height,
        )
        if required_scale > maximum_scale:
            continue
        context_scale = min(float(MIN_WORK_TILE_EDGE) / max(ratio_width, ratio_height), maximum_scale)
        scale = maximum_scale if prefer_edge_fill else max(required_scale, context_scale)
        crop_width = math.ceil(ratio_width * scale)
        crop_height = math.ceil(ratio_height * scale)
        # Integer crop origins sometimes need one extra pixel to contain a
        # floating-point planning box exactly.
        crop_width = max(crop_width, math.ceil(padded_box[2]) - math.floor(padded_box[0]))
        crop_height = max(crop_height, math.ceil(padded_box[3]) - math.floor(padded_box[1]))
        if max(crop_width, crop_height) > edge:
            continue
        crop = _place_crop(padded_box, crop_width, crop_height, image_width, image_height)
        if crop is not None:
            aspect_penalty = abs(math.log((crop_width / crop_height) / box_aspect))
            candidates.append((crop_width * crop_height, aspect_penalty, crop))
    if candidates:
        return min(candidates, key=lambda item: (item[0], item[1]))[2]
    if not allow_oversize:
        return None

    # Grow the preferred aspect ratio just enough to contain an oversized
    # person, including a modest context margin where the source permits it.
    for ratio_width, ratio_height in ((2, 3), (3, 2), (1, 2), (2, 1), (1, 1)):
        scale = max(desired_width / ratio_width, desired_height / ratio_height)
        crop_width = math.ceil(ratio_width * scale)
        crop_height = math.ceil(ratio_height * scale)
        crop_width = max(crop_width, math.ceil(padded_box[2]) - math.floor(padded_box[0]))
        crop_height = max(crop_height, math.ceil(padded_box[3]) - math.floor(padded_box[1]))
        crop = _place_crop(padded_box, crop_width, crop_height, image_width, image_height)
        if crop is not None:
            aspect_penalty = abs(math.log((crop_width / crop_height) / box_aspect))
            candidates.append((crop_width * crop_height, aspect_penalty, crop))
    if candidates:
        return min(candidates, key=lambda item: (item[0], item[1]))[2]

    # A source edge can make both preferred ratios impossible. Preserve the
    # complete person first and use the closest source-bounded rectangle.
    padded = [
        math.floor(padded_box[0]), math.floor(padded_box[1]),
        math.ceil(padded_box[2]), math.ceil(padded_box[3]),
    ]
    return [padded[0], padded[1], max(1, padded[2] - padded[0]), max(1, padded[3] - padded[1])]


def estimated_face_box(body_box):
    body_width = max(1.0, float(body_box[2]) - float(body_box[0]))
    body_height = max(1.0, float(body_box[3]) - float(body_box[1]))
    center_x = (float(body_box[0]) + float(body_box[2])) / 2
    return [
        center_x - body_width * 0.14,
        float(body_box[1]),
        center_x + body_width * 0.14,
        float(body_box[1]) + body_height * 0.24,
    ]


def face_shoulder_planning_box(item, image_width, image_height):
    """Return the protected head-and-shoulders region for a 4000px work tile."""
    body_box = clamp_box(item.get("planningBox", item["box"]), image_width, image_height)
    face_box = clamp_box(
        item.get("faceBox") or estimated_face_box(item["box"]),
        image_width, image_height,
    )
    body_width = max(1.0, body_box[2] - body_box[0])
    body_height = max(1.0, body_box[3] - body_box[1])
    face_width = max(1.0, face_box[2] - face_box[0])
    face_height = max(1.0, face_box[3] - face_box[1])
    center_x = (face_box[0] + face_box[2]) / 2

    # The face remains the anchor, while the protected width follows the
    # detected upper body closely enough to keep both shoulders visible.
    shoulder_width = max(face_width * 2.6, body_width * 0.82)
    top = min(body_box[1], face_box[1] - face_height * 0.18)
    bottom = max(
        face_box[3] + face_height * 1.35,
        body_box[1] + body_height * 0.34,
    )
    return clamp_box([
        center_x - shoulder_width / 2, top,
        center_x + shoulder_width / 2, bottom,
    ], image_width, image_height)


def mask_bounds(mask, scale, image_width, image_height):
    """Convert the visible segmentation extent from proxy to source pixels."""
    rows, columns = np.nonzero(np.asarray(mask) > 0)
    if not len(columns) or scale <= 0:
        return None
    return clamp_box([
        float(columns.min()) / scale,
        float(rows.min()) / scale,
        float(columns.max() + 1) / scale,
        float(rows.max() + 1) / scale,
    ], image_width, image_height)


def bounded_planning_box(body_box, visible_box, image_width, image_height):
    """Use segmentation details without letting a leaked mask reorder a crowd.

    Instance masks can occasionally include a neighbouring person.  The body
    detector remains the stable source of spatial order, while the mask may
    enlarge the planning box only by a bounded amount for hair, clothes and
    props extending beyond the detected body.
    """
    body_box = clamp_box(body_box, image_width, image_height)
    if visible_box is None:
        return body_box
    visible_box = clamp_box(visible_box, image_width, image_height)
    body_width = max(1.0, float(body_box[2]) - float(body_box[0]))
    body_height = max(1.0, float(body_box[3]) - float(body_box[1]))
    allowed = [
        float(body_box[0]) - body_width * 0.45,
        float(body_box[1]) - body_height * 0.20,
        float(body_box[2]) + body_width * 0.45,
        float(body_box[3]) + body_height * 0.20,
    ]
    return clamp_box([
        min(float(body_box[0]), max(float(visible_box[0]), allowed[0])),
        min(float(body_box[1]), max(float(visible_box[1]), allowed[1])),
        max(float(body_box[2]), min(float(visible_box[2]), allowed[2])),
        max(float(body_box[3]), min(float(visible_box[3]), allowed[3])),
    ], image_width, image_height)


def spatially_order_people(items):
    """Return stable left-to-right person numbering for a detected group."""
    return sorted(items, key=lambda item: (
        (float(item["box"][0]) + float(item["box"][2])) / 2,
        (float(item["box"][1]) + float(item["box"][3])) / 2,
        float(item["box"][0]),
        float(item["box"][1]),
    ))


def box_coverage_by_crop(box, crop):
    """Return how much of a detected person is visible inside a work crop."""
    crop_box = [crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]]
    intersection_width = max(0.0, min(float(box[2]), crop_box[2]) - max(float(box[0]), crop_box[0]))
    intersection_height = max(0.0, min(float(box[3]), crop_box[3]) - max(float(box[1]), crop_box[1]))
    box_area = max(1.0, (float(box[2]) - float(box[0])) * (float(box[3]) - float(box[1])))
    return intersection_width * intersection_height / box_area


def bystander_crop_penalty(coverage):
    """Penalize both visible bystanders and especially half-cut bodies."""
    coverage = float(np.clip(coverage, 0.0, 1.0))
    return coverage + 4.0 * coverage * (1.0 - coverage)


def reposition_crop_to_avoid_bystanders(crop, focus_box, image_width, image_height, bystander_boxes):
    """Slide a valid crop around its targets to avoid cutting adjacent people."""
    crop_width, crop_height = int(crop[2]), int(crop[3])
    minimum_left = max(0, int(math.ceil(float(focus_box[2]) - crop_width)))
    maximum_left = min(int(math.floor(float(focus_box[0]))), int(image_width) - crop_width)
    minimum_top = max(0, int(math.ceil(float(focus_box[3]) - crop_height)))
    maximum_top = min(int(math.floor(float(focus_box[1]))), int(image_height) - crop_height)
    if minimum_left > maximum_left or minimum_top > maximum_top:
        return crop

    def positions(current, minimum, maximum, boxes, start_index, end_index, size):
        values = {minimum, maximum, max(minimum, min(current, maximum))}
        for box in boxes:
            values.add(max(minimum, min(int(math.floor(float(box[start_index]) - size)), maximum)))
            values.add(max(minimum, min(int(math.ceil(float(box[end_index]))), maximum)))
        return sorted(values)

    left_positions = positions(int(crop[0]), minimum_left, maximum_left, bystander_boxes, 0, 2, crop_width)
    top_positions = positions(int(crop[1]), minimum_top, maximum_top, bystander_boxes, 1, 3, crop_height)
    best = None
    for left in left_positions:
        for top in top_positions:
            candidate_crop = [left, top, crop_width, crop_height]
            coverages = [box_coverage_by_crop(box, candidate_crop) for box in bystander_boxes]
            penalty = sum(bystander_crop_penalty(coverage) for coverage in coverages)
            distance = abs(left - int(crop[0])) + abs(top - int(crop[1]))
            score = (round(penalty, 6), distance)
            if best is None or score < best[0]:
                best = (score, candidate_crop)
    return best[1] if best else crop


def plan_work_tiles(items, image_width, image_height, edge=WORK_TILE_EDGE, oversize_crop_mode="expand"):
    """Plan spatially coherent work tiles with as little bystander duplication as possible."""
    count = len(items)
    if not count:
        return []

    candidate_cache = {}
    # Detection boxes, unlike segmentation extents, cannot suddenly span a
    # neighbouring person.  They are therefore the source of group order.
    centers = [
        ((float(item["box"][0]) + float(item["box"][2])) / 2,
         (float(item["box"][1]) + float(item["box"][3])) / 2)
        for item in items
    ]
    x_span = max(center[0] for center in centers) - min(center[0] for center in centers)
    y_span = max(center[1] for center in centers) - min(center[1] for center in centers)
    dominant_axis = 0 if x_span >= y_span else 1
    spatial_order = sorted(range(count), key=lambda index: (centers[index][dominant_axis], centers[index][1 - dominant_axis]))
    spatial_rank = {person_index: rank for rank, person_index in enumerate(spatial_order)}

    def is_contiguous(indices):
        ranks = sorted(spatial_rank[index] for index in indices)
        return ranks[-1] - ranks[0] + 1 == len(ranks)

    def candidate(indices):
        key = tuple(sorted(indices))
        if key not in candidate_cache:
            if len(key) > 1 and not is_contiguous(key):
                candidate_cache[key] = None
                return None
            box = union_box([items[index]["box"] for index in key])
            planning_box = union_box([items[index].get("planningBox", items[index]["box"]) for index in key])
            focus_box = planning_box
            focus_margin_ratio = 0.04 if len(key) > 1 else 0.08
            requires_manual_crop = False
            crop_reason = "完整人物范围可在工作图限制内安全容纳"
            crop = planned_work_crop(
                planning_box, image_width, image_height, edge,
                allow_oversize=False, margin_ratio=focus_margin_ratio,
            )
            # When complete bodies exceed the work-tile edge, keep nearby
            # people together by falling back to the union of their faces.
            # This restores the original group-photo behavior: one retoucher
            # receives one coherent area instead of one crop per person.
            if crop is None and oversize_crop_mode == "face-centered":
                focus_boxes = [
                    face_shoulder_planning_box(items[index], image_width, image_height)
                    for index in key
                ]
                focus_box = union_box(focus_boxes)
                focus_margin_ratio = 0.08
                crop = planned_work_crop(
                    focus_box, image_width, image_height, edge,
                    allow_oversize=False, prefer_edge_fill=True,
                )
                if crop is not None:
                    crop_reason = "人物范围超过限制，已改用人脸与肩部中心裁剪"
            if crop is None and oversize_crop_mode == "expand" and len(key) > 1:
                padded_group = expanded_planning_box(
                    planning_box, image_width, image_height, focus_margin_ratio,
                )
                padded_members = [
                    expanded_planning_box(
                        items[index].get("planningBox", items[index]["box"]),
                        image_width, image_height, focus_margin_ratio,
                    )
                    for index in key
                ]
                group_width = padded_group[2] - padded_group[0]
                group_height = padded_group[3] - padded_group[1]
                intrinsic_width = max(member[2] - member[0] for member in padded_members)
                intrinsic_height = max(member[3] - member[1] for member in padded_members)
                # Share an unavoidably oversized crop, but do not make a crop
                # oversized merely to connect people who are far apart.
                if ((group_width <= edge or intrinsic_width > edge)
                        and (group_height <= edge or intrinsic_height > edge)):
                    crop = planned_work_crop(
                        planning_box, image_width, image_height, edge,
                        allow_oversize=True, margin_ratio=focus_margin_ratio,
                    )
            if crop is None and len(key) == 1 and oversize_crop_mode == "expand":
                crop = planned_work_crop(box, image_width, image_height, edge, allow_oversize=True)
                if crop is not None:
                    crop_reason = "完整人物无法在限制内安全容纳，expand 策略允许扩大工作图"
            if crop is None and len(key) == 1 and oversize_crop_mode == "face-centered":
                face_box = face_shoulder_planning_box(items[key[0]], image_width, image_height)
                center_x = (face_box[0] + face_box[2]) / 2
                center_y = (face_box[1] + face_box[3]) / 2
                crop_width, crop_height = min(edge, image_width), min(edge, image_height)
                left = max(0, min(image_width - crop_width, int(round(center_x - crop_width / 2))))
                top = max(0, min(image_height - crop_height, int(round(center_y - crop_height / 2))))
                crop = [left, top, crop_width, crop_height]
                requires_manual_crop = True
                crop_reason = "人脸肩部范围无法在 4000px 限制内完整安全容纳，请人工调整裁剪"
            if crop is None:
                candidate_cache[key] = None
            else:
                selected = set(key)
                bystander_boxes = [item.get("planningBox", item["box"]) for index, item in enumerate(items) if index not in selected]
                safe_focus_box = expanded_planning_box(
                    focus_box, image_width, image_height, focus_margin_ratio,
                )
                crop = reposition_crop_to_avoid_bystanders(
                    crop, safe_focus_box, image_width, image_height, bystander_boxes,
                )
                bystander_coverages = [
                    box_coverage_by_crop(bystander_box, crop)
                    for bystander_box in bystander_boxes
                ]
                # Fully or mostly visible unassigned people are much more
                # dangerous than a small edge sliver. The retoucher must never
                # mistake them for members whose edits will be merged back.
                bystander_cost = sum(bystander_crop_penalty(coverage) for coverage in bystander_coverages)
                candidate_cache[key] = {
                    "indices": list(key), "box": box, "crop": crop,
                    "requiresManualCrop": requires_manual_crop,
                    "cropReason": crop_reason,
                    "fullFrame": crop[0] == 0 and crop[1] == 0 and crop[2] == image_width and crop[3] == image_height,
                    "sourceCoverage": float(crop[2] * crop[3]) / max(1, image_width * image_height),
                    "bystanderCost": bystander_cost,
                    "visibleBystanderCount": sum(coverage >= 0.8 for coverage in bystander_coverages),
                    "cutBystanderCount": sum(0.1 <= coverage < 0.8 for coverage in bystander_coverages),
                }
        return candidate_cache[key]

    if count <= 18:
        memo = {}

        def solve(remaining):
            if not remaining:
                return (0, 0, 0, 0.0, 0, [])
            if remaining in memo:
                return memo[remaining]
            first = (remaining & -remaining).bit_length() - 1
            others = [index for index in range(first + 1, count) if remaining & (1 << index)]
            options = []
            for group_size in range(1, min(MAX_PEOPLE_PER_TILE, len(others) + 1) + 1):
                for tail in itertools.combinations(others, group_size - 1):
                    group = (first, *tail)
                    tile = candidate(group)
                    if tile is None:
                        continue
                    next_remaining = remaining
                    for index in group:
                        next_remaining &= ~(1 << index)
                    child_visible_count, child_count, child_cut_count, child_bystander_cost, child_area, child_tiles = solve(next_remaining)
                    area = tile["crop"][2] * tile["crop"][3]
                    options.append((
                        child_visible_count + tile["visibleBystanderCount"],
                        child_count + 1,
                        child_cut_count + tile["cutBystanderCount"],
                        child_bystander_cost + tile["bystanderCost"],
                        child_area + area,
                        [tile, *child_tiles],
                    ))
            memo[remaining] = min(options, key=lambda item: (item[1], item[0], item[2], round(item[3], 6), item[4]))
            return memo[remaining]

        tiles = solve((1 << count) - 1)[5]
    else:
        # Large crowds avoid exponential search. Prefer the tightest triples,
        # then pairs, and finally guaranteed single-person crops.
        remaining = set(range(count))
        tiles = []
        while remaining:
            first = min(remaining)
            best = None
            for group_size in (3, 2, 1):
                for tail in itertools.combinations(sorted(remaining - {first}), group_size - 1):
                    tile = candidate((first, *tail))
                    if tile is None:
                        continue
                    area = tile["crop"][2] * tile["crop"][3]
                    score = (
                        tile["visibleBystanderCount"] / group_size,
                        tile["cutBystanderCount"] / group_size,
                        round(tile["bystanderCost"] / group_size, 6),
                        -group_size,
                        area / group_size,
                        tuple(tile["indices"]),
                    )
                    if best is None or score < best[0]:
                        best = (score, tile)
            tile = best[1] if best is not None else candidate((first,))
            tiles.append(tile)
            remaining.difference_update(tile["indices"])

    return sorted(tiles, key=lambda tile: min(tile["indices"]))


def overlap_review_reasons(items):
    reasons = [[] for _ in items]
    for left_index, left in enumerate(items):
        if left["source"] == "pairdetr-extra":
            reasons[left_index].append("补充检测人物，请确认")
        for right_index in range(left_index + 1, len(items)):
            if box_iou(left["box"], items[right_index]["box"]) >= 0.52:
                reasons[left_index].append("人物严重重叠，请确认归属")
                reasons[right_index].append("人物严重重叠，请确认归属")
    return ["；".join(dict.fromkeys(values)) for values in reasons]


def box_payload(box):
    return {
        "x": max(0, int(math.floor(box[0]))),
        "y": max(0, int(math.floor(box[1]))),
        "width": max(1, int(math.ceil(box[2] - box[0]))),
        "height": max(1, int(math.ceil(box[3] - box[1]))),
    }


def payload_box(value):
    if not isinstance(value, dict):
        return None
    x = float(value.get("x", 0))
    y = float(value.get("y", 0))
    width = float(value.get("width", 0))
    height = float(value.get("height", 0))
    if width <= 0 or height <= 0:
        return None
    return [x, y, x + width, y + height]


def generate_work_tasks(rgb, people, output_root, delivery_root, delivery_name, detector,
                        oversize_crop_mode="expand", progress_message="正在重新生成工作图"):
    """Build crops and masks from an already-known, deterministic person set."""
    height, width = rgb.shape[:2]
    people = spatially_order_people(people)
    if not people:
        return people, []
    proxy_width, proxy_height, proxy_scale = proxy_size(width, height)
    tiles = plan_work_tiles(people, width, height, oversize_crop_mode=oversize_crop_mode)
    emit_progress(78, f"{progress_message}：共 {len(tiles)} 张")
    tasks = []
    mask_directory = output_root / "masks"
    mask_directory.mkdir(parents=True, exist_ok=True)
    for index, tile in enumerate(tiles, start=1):
        emit_progress(78 + round(index / max(1, len(tiles)) * 19), f"正在生成第 {index}/{len(tiles)} 张工作图")
        members = [people[person_index] for person_index in tile["indices"]]
        final_mask = np.logical_or.reduce([member["mask"] for member in members])
        task_id = str(uuid.uuid4())
        mask_file = mask_directory / f"group-{index:02d}-{task_id}.png"
        save_mask(mask_file, final_mask)
        crop_x, crop_y, crop_width, crop_height = tile["crop"]
        patch_path = delivery_root / f"{delivery_name}_人物{index:02d}.png"
        Image.fromarray(rgb[crop_y:crop_y + crop_height, crop_x:crop_x + crop_width], "RGB").save(
            patch_path, format="PNG", compress_level=3
        )
        member_payload = []
        for person_index, member in zip(tile["indices"], members):
            member_payload.append({
                "personIndex": person_index + 1,
                "previousPersonIndex": int(member.get("previousPersonIndex") or person_index + 1),
                "confidence": float(member.get("score", 1)),
                "faceBox": box_payload(member["faceBox"]) if member.get("faceBox") else None,
                "bbox": box_payload(member["box"]),
                "planningBox": box_payload(member.get("planningBox", member["box"])),
                "reviewReason": str(member.get("reviewReason") or ""),
            })
        member_numbers = [str(member["personIndex"]) for member in member_payload]
        reason = "；".join(dict.fromkeys(
            member.get("reviewReason", "") for member in members if member.get("reviewReason")
        ))
        if tile.get("requiresManualCrop"):
            reason = "；".join(filter(None, (reason, tile.get("cropReason"))))
        patch_rgb = rgb[crop_y:crop_y + crop_height, crop_x:crop_x + crop_width]
        tasks.append({
            "id": task_id,
            "personIndex": index,
            "personName": f"人物 {'、'.join(member_numbers)}",
            "assignee": "",
            "detector": detector,
            "confidence": min(float(member.get("score", 1)) for member in members),
            "bbox": box_payload(tile["box"]),
            "members": member_payload,
            "crop": {"x": crop_x, "y": crop_y, "width": crop_width, "height": crop_height},
            "patchPath": str(patch_path),
            "maskPath": str(mask_file),
            "mask": {"width": proxy_width, "height": proxy_height, "scale": proxy_scale},
            "generation": {
                "version": 2, "strategy": oversize_crop_mode,
                "sourceWidth": width, "sourceHeight": height,
                "workWidth": crop_width, "workHeight": crop_height,
                "workDigest": hashlib.sha256(patch_rgb.tobytes()).hexdigest(),
                "fullFrame": bool(tile.get("fullFrame")),
                "sourceCoverage": round(float(tile.get("sourceCoverage", 0)), 6),
                "requiresManualCrop": bool(tile.get("requiresManualCrop")),
                "reason": str(tile.get("cropReason") or ""),
                "exceedsWorkTileEdge": max(crop_width, crop_height) > WORK_TILE_EDGE,
            },
            "requiresManualCrop": bool(tile.get("requiresManualCrop")),
            "fullFrame": bool(tile.get("fullFrame")),
            "sourceCoverage": round(float(tile.get("sourceCoverage", 0)), 6),
            "needsReview": bool(reason),
            "reviewReason": reason,
            "status": "exported",
        })
    return people, tasks


def detect(input_path, output_dir, preference="auto", delivery_dir=None, delivery_prefix=None,
           oversize_crop_mode="expand", advanced_runner=None, session_bundle=None,
           advanced_mode="auto", excluded_boxes=None):
    emit_progress(2, "正在读取原图")
    rgb = load_rgb(input_path)
    height, width = rgb.shape[:2]
    emit_progress(8, "正在加载人物检测模型")
    session, providers, backend = session_bundle or create_session(preference)
    fallback_reasons = []
    emit_progress(14, "正在检测图片中的人物")
    try:
        rtmdet = infer_rtmdet(session, rgb)
    except Exception as error:
        if preference != "auto" or backend != "gpu":
            raise
        fallback_reasons.append(f"DirectML 降级到 CPU：{error}")
        emit_progress(16, "GPU检测异常，正在切换CPU")
        session, providers, backend = create_session("cpu")
        rtmdet = infer_rtmdet(session, rgb)
    if not rtmdet:
        raise RuntimeError("RTMDet 没有检测到可靠人物")
    emit_progress(30, f"已找到 {len(rtmdet)} 个人物，正在确认人物位置")

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)
    delivery_root = Path(delivery_dir) if delivery_dir else output_root
    delivery_root.mkdir(parents=True, exist_ok=True)
    delivery_name = Path(delivery_prefix or Path(input_path).stem).name
    fused = [{
        "box": item["box"], "score": item["score"], "source": "rtmdet",
        "faceBox": None, "rtmdetIndex": index, "matchIou": 0.0,
    } for index, item in enumerate(rtmdet)]
    advanced_backend = False
    sam_masks = []
    if advanced_mode != "basic":
        try:
            if advanced_runner is None:
                from advanced_bridge import run_pairdetr, run_sam2
            else:
                run_pairdetr = advanced_runner.run_pairdetr
                run_sam2 = advanced_runner.run_sam2
            emit_progress(34, "正在确认每个人的位置")
            pair_boxes = run_pairdetr(Path(input_path), output_root, PAIRDETR_LOW_THRESHOLD)
            fused = fuse_boxes(rtmdet, pair_boxes)
            emit_progress(56, f"正在区分 {len(fused)} 个重叠人物")
            sam_masks = run_sam2(Path(input_path), fused, output_root)
            if len(sam_masks) != len(fused):
                raise RuntimeError(f"SAM 2.1 遮罩数量不一致：{len(sam_masks)}/{len(fused)}")
            advanced_backend = True
            emit_progress(78, "人物识别完成，正在把图片切小")
        except Exception as error:
            if advanced_mode == "advanced":
                raise RuntimeError(f"高级模式不可用：{advanced_fallback_reason(error)}") from error
            # PairDETR may have succeeded before SAM failed.  Its boxes are an
            # advanced-only intermediate and must never be mixed with RTMDet
            # masks when the advanced transaction did not complete.
            fused = [{
                "box": item["box"], "score": item["score"], "source": "rtmdet",
                "faceBox": None, "rtmdetIndex": index, "matchIou": 0.0,
            } for index, item in enumerate(rtmdet)]
            sam_masks = []
            advanced_backend = False
            fallback_reasons.append(advanced_fallback_reason(error))
            emit_progress(58, "正在使用基础识别结果把图片切小")
    else:
        emit_progress(58, "正在使用基础识别结果把图片切小")

    for item in fused:
        item["box"] = clamp_box(item["box"], width, height)
        if item.get("faceBox"):
            item["faceBox"] = clamp_box(item["faceBox"], width, height)

    exclusions = [box for box in (exclusion_xyxy(value) for value in (excluded_boxes or [])) if box]
    if exclusions:
        excluded_indices = excluded_detection_indices(fused, exclusions)
        retained_indices = [index for index in range(len(fused)) if index not in excluded_indices]
        removed_count = len(fused) - len(retained_indices)
        fused = [fused[index] for index in retained_indices]
        if sam_masks:
            sam_masks = [sam_masks[index] for index in retained_indices]
        if removed_count:
            emit_progress(60, f"已按人工排除记录忽略 {removed_count} 个误识别人物")

    review_reasons = overlap_review_reasons(fused)
    proxy_width, proxy_height, proxy_scale = proxy_size(width, height)
    people = []
    for person_index, item in enumerate(fused):
        box = item["box"]
        rtmdet_index = item.get("rtmdetIndex")
        rtm_mask = rtmdet[rtmdet_index]["mask"] if rtmdet_index is not None else None
        if advanced_backend:
            sam_mask_path = sam_masks[person_index]
            try:
                sam_mask = load_mask(sam_mask_path)
            except (OSError, ValueError) as error:
                raise RuntimeError(f"无法读取 SAM 2.1 遮罩：{sam_mask_path}") from error
            final_mask = combine_masks(sam_mask > 0, rtm_mask)
        elif rtm_mask is not None:
            final_mask = fill_mask_holes(rtm_mask)
        else:
            final_mask = np.zeros((proxy_height, proxy_width), dtype=bool)
        if final_mask.shape != (proxy_height, proxy_width):
            final_mask = cv2.resize(
                final_mask.astype(np.uint8), (proxy_width, proxy_height),
                interpolation=cv2.INTER_NEAREST,
            ) > 0
        visible_box = mask_bounds(final_mask, proxy_scale, width, height)
        planning_box = bounded_planning_box(item["box"], visible_box, width, height)
        people.append({
            **item,
            "mask": final_mask,
            "planningBox": planning_box,
            "reviewReason": review_reasons[person_index],
        })

    detector = "rtmdet-pairdetr-sam2" if advanced_backend else "rtmdet-ins-m"
    people, tasks = generate_work_tasks(
        rgb, people, output_root, delivery_root, delivery_name, detector,
        oversize_crop_mode=oversize_crop_mode,
        progress_message="人物识别完成，正在生成工作图",
    )

    manifest_path = output_root / "manifest.json"
    manifest_path.write_text(json.dumps({
        "source": str(input_path), "width": width, "height": height,
        "personCount": len(fused), "workTileEdge": WORK_TILE_EDGE,
        "oversizeCropMode": oversize_crop_mode, "tasks": tasks,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_progress(100, f"完成：{len(fused)} 个人物已生成 {len(tasks)} 张工作图")
    return {
        "success": True,
        "detector": detector,
        "backend": backend, "provider": session.get_providers()[0],
        "requestedMode": advanced_mode, "advancedBackend": advanced_backend,
        "providers": providers, "fallbackReason": "；".join(fallback_reasons),
        "width": width, "height": height, "workTileEdge": WORK_TILE_EDGE,
        "personCount": len(fused),
        "needsReviewCount": sum(bool(task["needsReview"]) for task in tasks),
        "tasks": tasks, "manifestPath": str(manifest_path),
    }


def restore_patches(input_path, manifest_path):
    """Recreate missing rectangular work images without running detection again."""
    rgb = load_rgb(input_path)
    height, width = rgb.shape[:2]
    with open(manifest_path, "r", encoding="utf-8") as source:
        manifest = json.load(source)
    restored = []
    for task in manifest.get("tasks", []):
        crop = task.get("crop") or {}
        x, y, crop_width, crop_height = (int(crop.get(key, 0)) for key in ("x", "y", "width", "height"))
        if crop_width < 1 or crop_height < 1 or x < 0 or y < 0 or x + crop_width > width or y + crop_height > height:
            raise ValueError(f"人物 {task.get('id') or ''} 的切图范围超出原图")
        patch_path = Path(task["patchPath"])
        patch_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(rgb[y:y + crop_height, x:x + crop_width], "RGB").save(
            patch_path, format="PNG", compress_level=3
        )
        restored.append(str(patch_path))
    return {"success": True, "restoredCount": len(restored), "paths": restored}
















def _normalized_correlation(left, right):
    left_values = np.asarray(left, dtype=np.float32)
    right_values = np.asarray(right, dtype=np.float32)
    left_mean = float(left_values.mean())
    right_mean = float(right_values.mean())
    left_centered = left_values - left_mean
    right_centered = right_values - right_mean
    denominator = float(np.linalg.norm(left_centered) * np.linalg.norm(right_centered))
    if denominator < 1e-6:
        return 1.0 if float(np.mean(np.abs(left_values - right_values))) < 1e-6 else 0.0
    return float(np.clip(np.sum(left_centered * right_centered) / denominator, -1.0, 1.0))


def _perceptual_hash(gray):
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    low_frequency = cv2.dct(small)[:8, :8].reshape(-1)
    coefficients = low_frequency[1:]
    median = float(np.median(coefficients))
    return coefficients > median


def describe_match_image(image_path):
    """Build edit-tolerant visual descriptors without relying on names or metadata."""
    rgb = load_rgb(image_path)
    height, width = rgb.shape[:2]
    scale = min(1.0, 960.0 / max(width, height))
    proxy = cv2.resize(
        rgb,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR,
    )
    gray = cv2.cvtColor(proxy, cv2.COLOR_RGB2GRAY)
    normalized = cv2.equalizeHist(gray)
    structure = cv2.resize(normalized, (96, 96), interpolation=cv2.INTER_AREA)
    edges = cv2.Canny(structure, 55, 145)
    sift = cv2.SIFT_create(nfeatures=900, contrastThreshold=0.025, edgeThreshold=12)
    keypoints, descriptors = sift.detectAndCompute(normalized, None)
    comparison = cv2.resize(rgb, (192, 192), interpolation=cv2.INTER_AREA)
    return {
        "path": str(image_path), "width": width, "height": height,
        "pixelDigest": hashlib.sha256(rgb.tobytes()).hexdigest(), "comparison": comparison,
        "proxyWidth": proxy.shape[1], "proxyHeight": proxy.shape[0],
        "structure": structure, "edges": edges, "hash": _perceptual_hash(normalized),
        "keypoints": keypoints or [], "descriptors": descriptors,
    }


def return_edit_evidence(returned, candidate):
    difference = np.mean(np.abs(
        returned["comparison"].astype(np.float32) - candidate["comparison"].astype(np.float32)
    ), axis=2)
    mean_absolute = float(np.mean(difference))
    changed_fraction = float(np.mean(difference > 4.0))
    exact_same = (returned["width"], returned["height"], returned["pixelDigest"]) == (
        candidate["width"], candidate["height"], candidate["pixelDigest"]
    )
    returned_ratio = returned["width"] / max(1, returned["height"])
    candidate_ratio = candidate["width"] / max(1, candidate["height"])
    aspect_delta = abs(math.log(max(1e-6, returned_ratio / candidate_ratio)))
    dimension_scale = math.sqrt(
        (returned["width"] * returned["height"]) / max(1, candidate["width"] * candidate["height"])
    )
    abnormal_dimensions = dimension_scale < 0.35 or dimension_scale > 2.5
    near_unchanged = exact_same or mean_absolute < 1.6 or (mean_absolute < 3.0 and changed_fraction < 0.008)
    return {
        "exactSame": exact_same, "nearUnchanged": near_unchanged,
        "meanAbsoluteDifference": round(mean_absolute, 4),
        "changedFraction": round(changed_fraction, 6),
        "aspectRatioDelta": round(aspect_delta, 6),
        "dimensionScale": round(dimension_scale, 6), "abnormalDimensions": abnormal_dimensions,
        "returnedSize": {"width": returned["width"], "height": returned["height"]},
        "workingSize": {"width": candidate["width"], "height": candidate["height"]},
        "reallyModified": not near_unchanged and aspect_delta <= 0.08 and not abnormal_dimensions,
    }


def fast_match_score(returned, candidate):
    structure = max(0.0, _normalized_correlation(returned["structure"], candidate["structure"]))
    edges = max(0.0, _normalized_correlation(returned["edges"], candidate["edges"]))
    hash_score = 1.0 - float(np.mean(returned["hash"] != candidate["hash"]))
    returned_ratio = returned["width"] / max(1, returned["height"])
    candidate_ratio = candidate["width"] / max(1, candidate["height"])
    aspect_score = math.exp(-3.5 * abs(math.log(max(1e-6, returned_ratio / candidate_ratio))))
    return float(np.clip(0.50 * structure + 0.24 * edges + 0.16 * hash_score + 0.10 * aspect_score, 0.0, 1.0))


def local_feature_score(returned, candidate):
    left = returned["descriptors"]
    right = candidate["descriptors"]
    if left is None or right is None or len(left) < 4 or len(right) < 4:
        return None
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    pairs = matcher.knnMatch(left, right, k=2)
    good = [first for pair in pairs if len(pair) == 2 for first, second in [pair] if first.distance < 0.76 * second.distance]
    if len(good) < 4:
        return 0.0
    source_points = np.float32([returned["keypoints"][match.queryIdx].pt for match in good])
    target_points = np.float32([candidate["keypoints"][match.trainIdx].pt for match in good])
    try:
        _matrix, inlier_mask = cv2.findHomography(source_points, target_points, cv2.RANSAC, 5.0)
    except cv2.error:
        return 0.0
    inliers = inlier_mask.ravel().astype(bool) if inlier_mask is not None else np.zeros(len(good), dtype=bool)
    inlier_count = int(inliers.sum())
    if inlier_count < 4:
        return 0.0

    def coverage(points, width, height):
        if len(points) < 3:
            return 0.0
        hull = cv2.convexHull(np.asarray(points, dtype=np.float32))
        return min(1.0, float(cv2.contourArea(hull)) / max(1.0, width * height))

    source_coverage = coverage(source_points[inliers], returned["proxyWidth"], returned["proxyHeight"])
    target_coverage = coverage(target_points[inliers], candidate["proxyWidth"], candidate["proxyHeight"])
    spread = min(1.0, math.sqrt(max(0.0, source_coverage * target_coverage)) * 3.0)
    inlier_ratio = inlier_count / max(1, len(good))
    count_score = min(1.0, inlier_count / 45.0)
    return float(np.clip(0.45 * inlier_ratio + 0.30 * count_score + 0.25 * spread, 0.0, 1.0))


def maximize_assignment(scores):
    """Hungarian assignment for a rectangular score matrix; each return is used once."""
    if not scores:
        return []
    row_count = len(scores)
    real_column_count = len(scores[0]) if scores[0] else 0
    if not real_column_count:
        return [-1] * row_count
    column_count = max(row_count, real_column_count)
    costs = [[1.0 - (scores[row][column] if column < real_column_count else 0.0)
              for column in range(column_count)] for row in range(row_count)]
    potentials_rows = [0.0] * (row_count + 1)
    potentials_columns = [0.0] * (column_count + 1)
    matched_row = [0] * (column_count + 1)
    previous_column = [0] * (column_count + 1)
    for row in range(1, row_count + 1):
        matched_row[0] = row
        minimum = [float("inf")] * (column_count + 1)
        used = [False] * (column_count + 1)
        column = 0
        while True:
            used[column] = True
            current_row = matched_row[column]
            delta, next_column = float("inf"), 0
            for candidate_column in range(1, column_count + 1):
                if used[candidate_column]:
                    continue
                reduced = costs[current_row - 1][candidate_column - 1] - potentials_rows[current_row] - potentials_columns[candidate_column]
                if reduced < minimum[candidate_column]:
                    minimum[candidate_column] = reduced
                    previous_column[candidate_column] = column
                if minimum[candidate_column] < delta:
                    delta, next_column = minimum[candidate_column], candidate_column
            for candidate_column in range(column_count + 1):
                if used[candidate_column]:
                    potentials_rows[matched_row[candidate_column]] += delta
                    potentials_columns[candidate_column] -= delta
                else:
                    minimum[candidate_column] -= delta
            column = next_column
            if matched_row[column] == 0:
                break
        while True:
            next_column = previous_column[column]
            matched_row[column] = matched_row[next_column]
            column = next_column
            if column == 0:
                break
    assignment = [-1] * row_count
    for column in range(1, column_count + 1):
        if matched_row[column] and column <= real_column_count:
            assignment[matched_row[column] - 1] = column - 1
    return assignment


def match_returned_batch(manifest_path):
    payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    returned_items = payload.get("returned") or []
    candidates = payload.get("candidates") or []
    if not returned_items:
        raise ValueError("没有收到可比对的修图结果")
    if not candidates:
        raise ValueError("当前项目没有可用于比对的原始工作图")

    emit_progress(2, "正在读取返回图片")
    returned_descriptors = []
    for index, item in enumerate(returned_items, start=1):
        returned_descriptors.append(describe_match_image(item["path"]))
        emit_progress(2 + 18 * index / len(returned_items), f"读取返回图片 {index}/{len(returned_items)}")
    candidate_descriptors = []
    for index, item in enumerate(candidates, start=1):
        candidate_descriptors.append(describe_match_image(item["patchPath"]))
        emit_progress(20 + 20 * index / len(candidates), f"读取原始工作图 {index}/{len(candidates)}")
    original_descriptors = {}
    for candidate in candidates:
        original_path = candidate.get("originalPath")
        if original_path and original_path not in original_descriptors and os.path.isfile(original_path):
            original_descriptors[original_path] = describe_match_image(original_path)

    scores = []
    for row_index, returned in enumerate(returned_descriptors):
        fast_scores = [fast_match_score(returned, candidate) for candidate in candidate_descriptors]
        detailed_indices = sorted(range(len(fast_scores)), key=lambda index: fast_scores[index], reverse=True)[:min(10, len(fast_scores))]
        combined = list(fast_scores)
        for candidate_index in detailed_indices:
            local_score = local_feature_score(returned, candidate_descriptors[candidate_index])
            if local_score is not None:
                combined[candidate_index] = 0.55 * fast_scores[candidate_index] + 0.45 * local_score
        scores.append(combined)
        emit_progress(40 + 48 * (row_index + 1) / len(returned_descriptors), f"比对图片 {row_index + 1}/{len(returned_descriptors)}")

    assignment = maximize_assignment(scores)
    matches = []
    for row_index, candidate_index in enumerate(assignment):
        returned_item = returned_items[row_index]
        if candidate_index < 0:
            matches.append({**returned_item, "matched": False, "confidence": "unmatched", "score": 0.0, "margin": 0.0, "alternatives": []})
            continue
        ranked = sorted(range(len(candidates)), key=lambda index: scores[row_index][index], reverse=True)
        score = float(scores[row_index][candidate_index])
        alternative_scores = [scores[row_index][index] for index in ranked if index != candidate_index]
        margin = score - (float(alternative_scores[0]) if alternative_scores else 0.0)
        if score >= 0.68 and margin >= 0.075:
            confidence = "high"
        elif score >= 0.55 and margin >= 0.025:
            confidence = "medium"
        else:
            confidence = "low"
        candidate = candidates[candidate_index]
        edit_evidence = return_edit_evidence(returned_descriptors[row_index], candidate_descriptors[candidate_index])
        warnings = []
        if edit_evidence["exactSame"]:
            warnings.append("返图与原始工作图完全相同，未检测到实际修改")
        elif edit_evidence["nearUnchanged"]:
            warnings.append("返图与原始工作图近似相同，修改证据不足")
        if edit_evidence["aspectRatioDelta"] > 0.08:
            warnings.append("返图长宽比与工作图异常不一致")
        if edit_evidence["abnormalDimensions"]:
            warnings.append("返图尺寸与工作图比例异常")
        original = original_descriptors.get(candidate.get("originalPath"))
        mistaken_original = False
        if original is not None:
            original_score = fast_match_score(returned_descriptors[row_index], original)
            same_original_pixels = returned_descriptors[row_index]["pixelDigest"] == original["pixelDigest"]
            original_ratio_delta = abs(math.log(max(1e-6,
                (returned_descriptors[row_index]["width"] / max(1, returned_descriptors[row_index]["height"])) /
                (original["width"] / max(1, original["height"])))))
            mistaken_original = same_original_pixels or (original_score >= 0.84 and original_ratio_delta <= 0.035
                and returned_descriptors[row_index]["width"] >= candidate_descriptors[candidate_index]["width"] * 1.15)
            edit_evidence["originalFrameScore"] = round(float(original_score), 4)
            edit_evidence["mistakenFullOriginal"] = mistaken_original
            if mistaken_original:
                warnings.append("疑似误传整张原图，而不是当前人物工作图")
        edit_evidence["reallyModified"] = bool(edit_evidence["reallyModified"] and not mistaken_original)
        if warnings and confidence == "high":
            confidence = "review"
        alternatives = [{
            "taskId": candidates[index].get("taskId"),
            "photoId": candidates[index].get("photoId"),
            "baseVersionId": candidates[index].get("baseVersionId"),
            "personIndex": candidates[index].get("personIndex"),
            "identityId": candidates[index].get("identityId"),
            "personName": candidates[index].get("personName"),
            "photoName": candidates[index].get("photoName"),
            "patchPath": candidates[index].get("patchPath"),
            "score": round(float(scores[row_index][index]), 4),
        } for index in ranked[:3]]
        matches.append({
            **returned_item, **candidate, "matched": True, "confidence": confidence,
            "matchConfidence": "high" if score >= 0.68 and margin >= 0.075 else ("medium" if score >= 0.55 and margin >= 0.025 else "low"),
            "score": round(score, 4), "margin": round(margin, 4), "editEvidence": edit_evidence,
            "returnWarnings": warnings, "needsReview": bool(warnings), "alternatives": alternatives,
        })
    emit_progress(100, "内容比对完成")
    return {
        "success": True, "matches": matches,
        "returnedCount": len(returned_items), "candidateCount": len(candidates),
        "highCount": sum(item.get("confidence") == "high" for item in matches),
        "reviewCount": sum(item.get("confidence") != "high" for item in matches),
    }


class UnavailableAdvancedRunner:
    def __init__(self, error):
        self.error = str(error)

    def run_pairdetr(self, *_args, **_kwargs):
        raise RuntimeError(self.error)

    def run_sam2(self, *_args, **_kwargs):
        raise RuntimeError(self.error)


def detect_batch(manifest_path, preference="auto", oversize_crop_mode="face-centered", advanced_mode="auto",
                 session_bundle=None, batch_runner=None):
    payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    items = payload.get("items") or []
    if not items:
        raise ValueError("请至少提供一张图片")
    session_bundle = session_bundle or create_session(preference)
    owns_advanced_session = batch_runner is None
    advanced_session = None
    if advanced_mode != "basic" and owns_advanced_session:
        try:
            from advanced_bridge import AdvancedBatchSession
            advanced_session = AdvancedBatchSession()
            batch_runner = advanced_session.__enter__()
        except Exception as error:
            if advanced_session:
                advanced_session.__exit__(None, None, None)
            advanced_session = None
            if advanced_mode == "advanced":
                raise RuntimeError(f"高级模式不可用：{advanced_fallback_reason(error)}") from error
            batch_runner = UnavailableAdvancedRunner(f"批量高级后端不可用：{error}")

    results = []
    try:
        for item_index, item in enumerate(items, start=1):
            PROGRESS_CONTEXT.clear()
            PROGRESS_CONTEXT.update({
                "itemIndex": item_index, "itemCount": len(items),
                "itemKey": str(item.get("key") or item_index),
                "itemName": str(item.get("name") or Path(item["input"]).name),
            })
            emit_progress(1, f"准备识别第 {item_index}/{len(items)} 张图片")
            try:
                result = detect(
                    os.path.abspath(item["input"]), os.path.abspath(item["outputDir"]),
                    preference, os.path.abspath(item["deliveryDir"]), item.get("deliveryPrefix"),
                    oversize_crop_mode, batch_runner, session_bundle, advanced_mode,
                    item.get("excludedBoxes") or [],
                )
                results.append({
                    "success": True, "key": item.get("key"), "name": item.get("name"),
                    **result,
                })
            except Exception as error:
                results.append({
                    "success": False, "key": item.get("key"), "name": item.get("name"),
                    "error": str(error), "tasks": [],
                })
    finally:
        PROGRESS_CONTEXT.clear()
        if advanced_session and owns_advanced_session:
            advanced_session.__exit__(None, None, None)
    return {
        "success": any(item.get("success") for item in results),
        "results": results,
        "persistentBackend": advanced_session is not None,
        "requestedMode": advanced_mode,
        "advancedUsedCount": sum(item.get("advancedBackend") is True for item in results),
        "fallbackCount": sum(bool(item.get("fallbackReason")) for item in results),
    }


def identify_people(manifest_path, runtime=None, provider="auto"):
    payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    subjects = payload.get("subjects") or []
    if not subjects:
        return {"success": True, "clusters": [], "subjectCount": 0, "method": "face-osnet-gallery-v3"}
    if len(subjects) > 2000:
        raise ValueError("单次人物识别最多支持 2000 个主体；请拆分批次以限制两两比较内存")
    runtime = runtime or IdentityRuntime(asset_path("models", "face_detection_yunet_2023mar.onnx").parent, provider)
    image_shapes, descriptors = {}, []
    for item in subjects:
        image_path = os.path.abspath(item["path"])
        with Image.open(image_path) as source:
            image_shapes[str(item.get("photoId") or "")] = (source.height, source.width)
    add_occlusion_estimates(subjects, image_shapes)
    subjects_by_image = {}
    for item in subjects:
        subjects_by_image.setdefault(os.path.abspath(item["path"]), []).append(item)
    described_count = 0
    for image_path, image_subjects in subjects_by_image.items():
        rgb = load_rgb(image_path)
        image_descriptors = []
        for item in image_subjects:
            image_descriptors.append(runtime.describe(rgb, item))
            described_count += 1
            emit_progress(5 + 38 * described_count / len(subjects), f"检测并对齐人脸 {described_count}/{len(subjects)}")
        runtime.embed_bodies(image_descriptors)
        descriptors.extend(image_descriptors)
        del rgb
    emit_progress(72, "已提取 OSNet 人体特征，正在执行受约束聚类")
    pair_cache = CompactPairMetrics(len(descriptors))
    clusters = constrained_clusters(descriptors, pair_cache)
    similarities = ranked_similarity_pairs(descriptors, metrics_cache=pair_cache)
    emit_progress(100, "跨图片人物候选分组完成")
    return {
        "success": True, "subjectCount": len(subjects),
        "clusters": clusters,
        "similarities": similarities,
        "unmatchedCount": len(subjects) - len({member["key"] for cluster in clusters for member in cluster["members"]}),
        "method": f"{getattr(runtime, 'face_backend', 'test-face')}-{getattr(runtime, 'body_backend', 'test-body')}-gallery-v3",
        "faceBackend": getattr(runtime, "face_backend", "test-face"),
        "bodyBackend": getattr(runtime, "body_backend", "test-body"),
        "provider": runtime.provider,
    }


def probe():
    providers = []
    cpu_available = gpu_available = merge_available = advanced_available = identity_available = False
    face_backend = ""
    body_backend = ""
    runtime_errors, gpu_error, advanced_error, identity_error = [], "", "", ""
    try:
        from patch_merge import merge as _merge
        merge_available = callable(_merge)
    except Exception as error:
        runtime_errors.append(f"拼回引擎: {error}")
    try:
        session, providers, _ = create_session("cpu")
        zero = np.zeros((1, 3, RTMDET_INPUT_SIZE, RTMDET_INPUT_SIZE), dtype=np.float32)
        session.run(None, {session.get_inputs()[0].name: zero})
        cpu_available = True
    except Exception as error:
        runtime_errors.append(str(error))
    if cpu_available:
        try:
            session, providers, _ = create_session("gpu")
            zero = np.zeros((1, 3, RTMDET_INPUT_SIZE, RTMDET_INPUT_SIZE), dtype=np.float32)
            session.run(None, {session.get_inputs()[0].name: zero})
            gpu_available = True
        except Exception as error:
            gpu_error = str(error)
    try:
        from advanced_bridge import probe_advanced
        advanced_available, advanced_error = probe_advanced()
    except Exception as error:
        advanced_error = str(error)
    try:
        identity_runtime = IdentityRuntime(asset_path("models", "face_detection_yunet_2023mar.onnx").parent, "cpu")
        identity_runtime.body_session.run(None, {identity_runtime.body_input_name: np.zeros((1, 3, 256, 128), dtype=np.float32)})
        face_backend = identity_runtime.face_backend
        body_backend = identity_runtime.body_backend
        identity_available = True
    except Exception as error:
        identity_error = str(error)
    runtime_error = "；".join(runtime_errors)
    return {
        "success": True, "componentAvailable": cpu_available and merge_available,
        "cpuAvailable": cpu_available, "gpuAvailable": gpu_available,
        "advancedAvailable": advanced_available, "mergeAvailable": merge_available,
        "identityAvailable": identity_available,
        "faceBackend": face_backend,
        "bodyBackend": body_backend,
        "provider": "DmlExecutionProvider" if gpu_available else "CPUExecutionProvider" if cpu_available else "",
        "providers": providers, "runtimeError": runtime_error, "gpuError": gpu_error,
        "advancedError": advanced_error, "identityError": identity_error, "error": runtime_error or gpu_error,
    }


def probe_advanced_runtime():
    from advanced_bridge import AdvancedBatchSession
    with AdvancedBatchSession() as session:
        return {
            "success": True,
            "pairDetrReady": session.pair is not None,
            "sam2Ready": session.sam is not None,
            "distro": session.pair.distro if session.pair else "",
        }


def probe_advanced_installation():
    from advanced_bridge import probe_advanced
    available, error = probe_advanced()
    return {
        "success": True,
        "advancedAvailable": available,
        "pairDetrReady": available,
        "sam2Ready": available,
        "advancedError": error,
    }


def create_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("probe", "probe-advanced-installation", "probe-advanced-runtime", "detect", "detect-batch", "identify", "match-batch", "restore", "merge"))
    parser.add_argument("--input")
    parser.add_argument("--output-dir")
    parser.add_argument("--delivery-dir")
    parser.add_argument("--delivery-prefix")
    parser.add_argument("--manifest")
    parser.add_argument("--output")
    parser.add_argument("--provider", choices=("auto", "gpu", "cpu"), default="auto")
    parser.add_argument("--advanced-mode", choices=("auto", "basic", "advanced"), default="auto")
    parser.add_argument("--oversize-crop-mode", choices=("face-centered", "expand"), default="face-centered")
    parser.add_argument("--excluded-boxes", default="[]")
    return parser


def run(args_list=None):
    parser = create_parser()
    args = parser.parse_args(args_list)
    if args.action == "probe":
        emit(probe())
        return
    if args.action == "probe-advanced-runtime":
        emit(probe_advanced_runtime())
        return
    if args.action == "probe-advanced-installation":
        emit(probe_advanced_installation())
        return
    if args.action == "merge":
        if not args.input or not args.manifest or not args.output:
            parser.error("merge requires --input, --manifest and --output")
        from patch_merge import merge
        emit(merge(os.path.abspath(args.input), os.path.abspath(args.manifest), os.path.abspath(args.output)))
        return
    if args.action == "detect-batch":
        if not args.manifest:
            parser.error("detect-batch requires --manifest")
        emit(detect_batch(os.path.abspath(args.manifest), args.provider, args.oversize_crop_mode, args.advanced_mode))
        return
    if args.action == "match-batch":
        if not args.manifest:
            parser.error("match-batch requires --manifest")
        emit(match_returned_batch(os.path.abspath(args.manifest)))
        return
    if args.action == "identify":
        if not args.manifest:
            parser.error("identify requires --manifest")
        emit(identify_people(os.path.abspath(args.manifest), provider=args.provider))
        return
    if args.action == "restore":
        if not args.input or not args.manifest:
            parser.error("restore requires --input and --manifest")
        emit(restore_patches(os.path.abspath(args.input), os.path.abspath(args.manifest)))
        return
    if not args.input or not args.output_dir:
        parser.error("detect requires --input and --output-dir")
    emit(detect(
        os.path.abspath(args.input), os.path.abspath(args.output_dir), args.provider,
        os.path.abspath(args.delivery_dir) if args.delivery_dir else None,
        args.delivery_prefix, args.oversize_crop_mode, advanced_mode=args.advanced_mode,
        excluded_boxes=json.loads(args.excluded_boxes or "[]"),
    ))


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
