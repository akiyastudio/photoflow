"""PhotoFlow multi-person retouch engine.

RTMDet supplies the stable person set.  When the optional WSL CUDA runtime is
available, PairDETR corrects body boxes and SAM 2.1 supplies fine instance
masks. Nearby people share adaptive 2:3 or 3:2 context tiles; this is not a
person cut-out workflow.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import sys
import uuid
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps


Image.MAX_IMAGE_PIXELS = None

RTMDET_INPUT_SIZE = 640
RTMDET_SCORE_THRESHOLD = 0.45
PAIRDETR_LOW_THRESHOLD = 0.20
PAIRDETR_EXTRA_THRESHOLD = 0.50
PAIR_MATCH_IOU = 0.15
WORK_TILE_EDGE = 4000
MAX_PEOPLE_PER_TILE = 3
MASK_PROXY_EDGE = 4096
RTMDET_MODEL_NAME = "rtmdet-ins_m_640x640.onnx"
PROGRESS_CONTEXT = {}


def emit(result):
    print(json.dumps(result, ensure_ascii=False), flush=True)


def emit_progress(progress, message):
    emit({
        "type": "progress", "progress": max(0, min(100, int(progress))),
        "message": str(message), **PROGRESS_CONTEXT,
    })


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
    raise FileNotFoundError(f"多人修脸模型或脚本不存在：{candidates[0]}")


def model_path(name=RTMDET_MODEL_NAME):
    return asset_path("models", name)


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


def fuse_boxes(rtmdet, pair_boxes):
    candidates = []
    for rtmdet_index, baseline in enumerate(rtmdet):
        for pair_index, pair in enumerate(pair_boxes):
            overlap = box_iou(baseline["box"], pair["box_xyxy"])
            if overlap >= PAIR_MATCH_IOU:
                candidates.append((overlap, rtmdet_index, pair_index))
    matched_rtmdet, matched_pair, matches = set(), set(), {}
    for overlap, rtmdet_index, pair_index in sorted(candidates, reverse=True):
        if rtmdet_index in matched_rtmdet or pair_index in matched_pair:
            continue
        matched_rtmdet.add(rtmdet_index)
        matched_pair.add(pair_index)
        matches[rtmdet_index] = (pair_index, overlap)

    fused = []
    for rtmdet_index, baseline in enumerate(rtmdet):
        if rtmdet_index in matches:
            pair_index, overlap = matches[rtmdet_index]
            pair = pair_boxes[pair_index]
            fused.append({
                "box": pair["box_xyxy"], "score": pair["pair_score"],
                "faceBox": pair.get("face_box_xyxy"),
                "source": "pairdetr-matched", "rtmdetIndex": rtmdet_index,
                "matchIou": overlap,
            })
        else:
            fused.append({
                "box": baseline["box"], "score": baseline["score"],
                "faceBox": None,
                "source": "rtmdet-fallback", "rtmdetIndex": rtmdet_index,
                "matchIou": 0.0,
            })
    for pair_index, pair in enumerate(pair_boxes):
        if pair_index not in matched_pair and float(pair["pair_score"]) >= PAIRDETR_EXTRA_THRESHOLD:
            fused.append({
                "box": pair["box_xyxy"], "score": pair["pair_score"],
                "faceBox": pair.get("face_box_xyxy"),
                "source": "pairdetr-extra", "rtmdetIndex": None, "matchIou": 0.0,
            })
    fused.sort(key=lambda item: ((item["box"][1] + item["box"][3]) / 2, (item["box"][0] + item["box"][2]) / 2))
    return fused


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


def _preferred_crop_sizes(image_width, image_height, edge=WORK_TILE_EDGE):
    sizes = []
    for ratio_width, ratio_height in ((2, 3), (3, 2)):
        scale = min(
            float(edge) / max(ratio_width, ratio_height),
            float(image_width) / ratio_width,
            float(image_height) / ratio_height,
        )
        sizes.append((max(1, round(ratio_width * scale)), max(1, round(ratio_height * scale))))
    return sizes


def planned_work_crop(box, image_width, image_height, edge=WORK_TILE_EDGE, allow_oversize=True):
    """Return a 2:3/3:2 crop containing a complete person/group.

    Normal work images use at most ``edge`` pixels on their longest side. If a
    single person's detected body cannot fit, the crop grows beyond that limit
    instead of cutting the person off.
    """
    box_width = max(1.0, float(box[2]) - float(box[0]))
    box_height = max(1.0, float(box[3]) - float(box[1]))
    box_aspect = box_width / box_height
    candidates = []
    for crop_width, crop_height in _preferred_crop_sizes(image_width, image_height, edge):
        crop = _place_crop(box, crop_width, crop_height, image_width, image_height)
        if crop is not None:
            aspect_penalty = abs(math.log((crop_width / crop_height) / box_aspect))
            candidates.append((aspect_penalty, crop_width * crop_height, crop))
    if candidates:
        return min(candidates, key=lambda item: (item[0], item[1]))[2]
    if not allow_oversize:
        return None

    # Grow the preferred aspect ratio just enough to contain an oversized
    # person, including a modest context margin where the source permits it.
    margin_x = max(64.0, box_width * 0.06)
    margin_y = max(64.0, box_height * 0.06)
    desired_width = min(float(image_width), box_width + margin_x * 2)
    desired_height = min(float(image_height), box_height + margin_y * 2)
    for ratio_width, ratio_height in ((2, 3), (3, 2)):
        scale = max(desired_width / ratio_width, desired_height / ratio_height)
        crop_width = math.ceil(ratio_width * scale)
        crop_height = math.ceil(ratio_height * scale)
        crop = _place_crop(box, crop_width, crop_height, image_width, image_height)
        if crop is not None:
            aspect_penalty = abs(math.log((crop_width / crop_height) / box_aspect))
            candidates.append((aspect_penalty, crop_width * crop_height, crop))
    if candidates:
        return min(candidates, key=lambda item: (item[0], item[1]))[2]

    # A source edge can make both preferred ratios impossible. Preserve the
    # complete person first and use the closest source-bounded rectangle.
    padded = [
        max(0, math.floor(float(box[0]) - margin_x)),
        max(0, math.floor(float(box[1]) - margin_y)),
        min(image_width, math.ceil(float(box[2]) + margin_x)),
        min(image_height, math.ceil(float(box[3]) + margin_y)),
    ]
    return [padded[0], padded[1], max(1, padded[2] - padded[0]), max(1, padded[3] - padded[1])]


def centered_work_crop(box, image_width, image_height, edge=WORK_TILE_EDGE):
    """Backward-compatible entry point for callers and existing tests."""
    return planned_work_crop(box, image_width, image_height, edge, allow_oversize=True)


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


def plan_work_tiles(items, image_width, image_height, edge=WORK_TILE_EDGE, oversize_crop_mode="expand"):
    """Partition people into the fewest valid one-to-three-person work tiles."""
    count = len(items)
    if not count:
        return []

    candidate_cache = {}

    def candidate(indices):
        key = tuple(sorted(indices))
        if key not in candidate_cache:
            box = union_box([items[index]["box"] for index in key])
            crop = planned_work_crop(box, image_width, image_height, edge, allow_oversize=False)
            if crop is None and oversize_crop_mode == "face-centered":
                focus_boxes = [
                    clamp_box(items[index].get("faceBox") or estimated_face_box(items[index]["box"]), image_width, image_height)
                    for index in key
                ]
                crop = planned_work_crop(union_box(focus_boxes), image_width, image_height, edge, allow_oversize=False)
            if crop is None and len(key) == 1:
                crop = planned_work_crop(box, image_width, image_height, edge, allow_oversize=True)
            candidate_cache[key] = None if crop is None else {
                "indices": list(key), "box": box, "crop": crop,
            }
        return candidate_cache[key]

    if count <= 18:
        memo = {}

        def solve(remaining):
            if not remaining:
                return (0, 0, [])
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
                    child_count, child_area, child_tiles = solve(next_remaining)
                    area = tile["crop"][2] * tile["crop"][3]
                    options.append((child_count + 1, child_area + area, [tile, *child_tiles]))
            memo[remaining] = min(options, key=lambda item: (item[0], item[1]))
            return memo[remaining]

        tiles = solve((1 << count) - 1)[2]
    else:
        # Large crowds avoid exponential search. Prefer the tightest triples,
        # then pairs, and finally guaranteed single-person crops.
        remaining = set(range(count))
        tiles = []
        while remaining:
            first = min(remaining)
            best = None
            for group_size in (3, 2):
                for tail in itertools.combinations(sorted(remaining - {first}), group_size - 1):
                    tile = candidate((first, *tail))
                    if tile is None:
                        continue
                    area = tile["crop"][2] * tile["crop"][3]
                    score = (area, tuple(tile["indices"]))
                    if best is None or score < best[0]:
                        best = (score, tile)
                if best is not None:
                    break
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


def detect(input_path, output_dir, preference="auto", delivery_dir=None, delivery_prefix=None,
           oversize_crop_mode="expand", advanced_runner=None, session_bundle=None):
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
        fallback_reasons.append(f"高级后端降级为 RTMDet：{error}")
        emit_progress(58, "正在使用基础识别结果把图片切小")

    for item in fused:
        item["box"] = clamp_box(item["box"], width, height)
        if item.get("faceBox"):
            item["faceBox"] = clamp_box(item["faceBox"], width, height)

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
        people.append({**item, "mask": final_mask, "reviewReason": review_reasons[person_index]})

    tiles = plan_work_tiles(people, width, height, oversize_crop_mode=oversize_crop_mode)
    emit_progress(78, f"人物识别完成，正在生成 {len(tiles)} 张工作图")
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
        box = tile["box"]
        bbox = {
            "x": max(0, int(math.floor(box[0]))), "y": max(0, int(math.floor(box[1]))),
            "width": max(1, int(math.ceil(box[2] - box[0]))),
            "height": max(1, int(math.ceil(box[3] - box[1]))),
        }
        member_payload = []
        for person_index, member in zip(tile["indices"], members):
            member_box = member["box"]
            member_payload.append({
                "personIndex": person_index + 1,
                "confidence": float(member["score"]),
                "faceBox": ({
                    "x": max(0, int(math.floor(member["faceBox"][0]))),
                    "y": max(0, int(math.floor(member["faceBox"][1]))),
                    "width": max(1, int(math.ceil(member["faceBox"][2] - member["faceBox"][0]))),
                    "height": max(1, int(math.ceil(member["faceBox"][3] - member["faceBox"][1]))),
                } if member.get("faceBox") else None),
                "bbox": {
                    "x": max(0, int(math.floor(member_box[0]))),
                    "y": max(0, int(math.floor(member_box[1]))),
                    "width": max(1, int(math.ceil(member_box[2] - member_box[0]))),
                    "height": max(1, int(math.ceil(member_box[3] - member_box[1]))),
                },
            })
        member_numbers = [str(member["personIndex"]) for member in member_payload]
        reason = "；".join(dict.fromkeys(
            member["reviewReason"] for member in members if member["reviewReason"]
        ))
        tasks.append({
            "id": task_id, "personIndex": index,
            "personName": f"人物 {'、'.join(member_numbers)}", "assignee": "",
            "detector": "rtmdet-pairdetr-sam2" if advanced_backend else "rtmdet-ins-m",
            "confidence": min(float(member["score"]) for member in members), "bbox": bbox,
            "members": member_payload,
            "crop": {"x": crop_x, "y": crop_y, "width": crop_width, "height": crop_height},
            "patchPath": str(patch_path), "maskPath": str(mask_file),
            "mask": {"width": proxy_width, "height": proxy_height, "scale": proxy_scale},
            "needsReview": bool(reason), "reviewReason": reason,
            "status": "exported",
        })

    manifest_path = output_root / "manifest.json"
    manifest_path.write_text(json.dumps({
        "source": str(input_path), "width": width, "height": height,
        "personCount": len(fused), "workTileEdge": WORK_TILE_EDGE,
        "oversizeCropMode": oversize_crop_mode, "tasks": tasks,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_progress(100, f"完成：{len(fused)} 个人物已生成 {len(tasks)} 张工作图")
    return {
        "success": True,
        "detector": "rtmdet-pairdetr-sam2" if advanced_backend else "rtmdet-ins-m",
        "backend": backend, "provider": session.get_providers()[0],
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


class UnavailableAdvancedRunner:
    def __init__(self, error):
        self.error = str(error)

    def run_pairdetr(self, *_args, **_kwargs):
        raise RuntimeError(self.error)

    def run_sam2(self, *_args, **_kwargs):
        raise RuntimeError(self.error)


def detect_batch(manifest_path, preference="auto", oversize_crop_mode="face-centered"):
    payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    items = payload.get("items") or []
    if len(items) < 2:
        raise ValueError("批量识别至少需要两张图片")
    session_bundle = create_session(preference)
    batch_runner = None
    advanced_session = None
    try:
        from advanced_bridge import AdvancedBatchSession
        advanced_session = AdvancedBatchSession()
        batch_runner = advanced_session.__enter__()
    except Exception as error:
        if advanced_session:
            advanced_session.__exit__(None, None, None)
        advanced_session = None
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
                    oversize_crop_mode, batch_runner, session_bundle,
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
        if advanced_session:
            advanced_session.__exit__(None, None, None)
    return {
        "success": any(item.get("success") for item in results),
        "results": results,
        "persistentBackend": advanced_session is not None,
    }


def probe():
    providers = []
    cpu_available = gpu_available = merge_available = advanced_available = False
    runtime_errors, gpu_error, advanced_error = [], "", ""
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
    runtime_error = "；".join(runtime_errors)
    return {
        "success": True, "componentAvailable": cpu_available and merge_available,
        "cpuAvailable": cpu_available, "gpuAvailable": gpu_available,
        "advancedAvailable": advanced_available, "mergeAvailable": merge_available,
        "provider": "DmlExecutionProvider" if gpu_available else "CPUExecutionProvider" if cpu_available else "",
        "providers": providers, "runtimeError": runtime_error, "gpuError": gpu_error,
        "advancedError": advanced_error, "error": runtime_error or gpu_error,
    }


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("probe", "detect", "detect-batch", "restore", "merge"))
    parser.add_argument("--input")
    parser.add_argument("--output-dir")
    parser.add_argument("--delivery-dir")
    parser.add_argument("--delivery-prefix")
    parser.add_argument("--manifest")
    parser.add_argument("--output")
    parser.add_argument("--provider", choices=("auto", "gpu", "cpu"), default="auto")
    parser.add_argument("--oversize-crop-mode", choices=("face-centered", "expand"), default="face-centered")
    args = parser.parse_args(args_list)
    if args.action == "probe":
        emit(probe())
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
        emit(detect_batch(os.path.abspath(args.manifest), args.provider, args.oversize_crop_mode))
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
        args.delivery_prefix, args.oversize_crop_mode,
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
