"""Optional complete team-retouch engine for PhotoFlow.

This single component owns GPU/CPU person detection, lossless patch export and
high-resolution patch recomposition. The Electron core only orchestrates files,
task records and media versions.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import uuid
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps


INPUT_SIZE = 224
SCORE_THRESHOLD = 0.55
NMS_THRESHOLD = 0.42
MODEL_NAME = "person_detection_mediapipe_2023mar.onnx"


def emit(result):
    print(json.dumps(result, ensure_ascii=False), flush=True)


def component_directory():
    return Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent


def model_path():
    candidates = [component_directory() / "models" / MODEL_NAME]
    if hasattr(sys, "_MEIPASS"):
        candidates.append(Path(sys._MEIPASS) / "models" / MODEL_NAME)
    candidates.append(Path(__file__).resolve().parent / "models" / MODEL_NAME)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"GPU 人物检测模型不存在：{candidates[0]}")


def create_anchors():
    """Generate the 2,254 fixed anchors used by MediaPipe Person Detector."""
    strides = [8, 16, 32, 32, 32]
    anchors = []
    layer_id = 0
    while layer_id < len(strides):
        anchor_count = 0
        last_same_stride_layer = layer_id
        while last_same_stride_layer < len(strides) and strides[last_same_stride_layer] == strides[layer_id]:
            # One square anchor plus one interpolated square anchor per layer.
            anchor_count += 2
            last_same_stride_layer += 1
        feature_map = int(math.ceil(INPUT_SIZE / strides[layer_id]))
        for y in range(feature_map):
            for x in range(feature_map):
                center = ((x + 0.5) / feature_map, (y + 0.5) / feature_map)
                anchors.extend([center] * anchor_count)
        layer_id = last_same_stride_layer
    result = np.asarray(anchors, dtype=np.float32)
    if result.shape != (2254, 2):
        raise RuntimeError(f"MediaPipe anchor 数量异常：{result.shape}")
    return result


ANCHORS = create_anchors()


def create_session(preference="auto"):
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError("GPU 组件缺少 onnxruntime-directml 运行库") from error
    providers = ort.get_available_providers()
    options = ort.SessionOptions()
    if preference != "cpu" and "DmlExecutionProvider" in providers:
        # These settings are required by the DirectML execution provider.
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        try:
            session = ort.InferenceSession(str(model_path()), sess_options=options, providers=["DmlExecutionProvider", "CPUExecutionProvider"])
            return session, providers, "gpu"
        except Exception:
            if preference == "gpu":
                raise
    elif preference == "gpu":
        raise RuntimeError(f"DirectML GPU 不可用；当前运行库提供：{', '.join(providers) or '无'}")
    if "CPUExecutionProvider" not in providers:
        raise RuntimeError(f"ONNX CPU 执行器不可用；当前运行库提供：{', '.join(providers) or '无'}")
    session = ort.InferenceSession(str(model_path()), sess_options=ort.SessionOptions(), providers=["CPUExecutionProvider"])
    return session, providers, "cpu"


def load_rgb(path):
    with Image.open(path) as source:
        source.load()
        return np.asarray(ImageOps.exif_transpose(source).convert("RGB"))


def preprocess(rgb):
    height, width = rgb.shape[:2]
    ratio = min(INPUT_SIZE / height, INPUT_SIZE / width)
    resized_width = max(1, int(width * ratio))
    resized_height = max(1, int(height * ratio))
    resampling = getattr(Image, "Resampling", Image).BILINEAR
    resized = np.asarray(Image.fromarray(rgb, "RGB").resize((resized_width, resized_height), resampling), dtype=np.float32)
    left = (INPUT_SIZE - resized_width) // 2
    top = (INPUT_SIZE - resized_height) // 2
    canvas = np.zeros((INPUT_SIZE, INPUT_SIZE, 3), dtype=np.float32)
    canvas[top:top + resized_height, left:left + resized_width] = resized / 127.5 - 1.0
    blob = np.transpose(canvas, (2, 0, 1))[None].astype(np.float32)
    return blob, np.asarray([left / ratio, top / ratio], dtype=np.float32)


def sigmoid(values):
    values = np.clip(values.astype(np.float64), -100, 100)
    return 1.0 / (1.0 + np.exp(-values))


def iou(left, right):
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0


def nms(detections, threshold=NMS_THRESHOLD):
    kept = []
    for detection in sorted(detections, key=lambda value: value["score"], reverse=True):
        box = detection["box"]
        center_x, center_y = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        duplicate = False
        for candidate in kept:
            other = candidate["box"]
            other_x, other_y = (other[0] + other[2]) / 2, (other[1] + other[3]) / 2
            minimum_size = min(box[2] - box[0], box[3] - box[1], other[2] - other[0], other[3] - other[1])
            if iou(box, other) >= threshold or math.hypot(center_x - other_x, center_y - other_y) < minimum_size * 0.16:
                duplicate = True
                break
        if not duplicate:
            kept.append(detection)
    return sorted(kept, key=lambda value: ((value["box"][1] + value["box"][3]) / 2, (value["box"][0] + value["box"][2]) / 2))


def decode_outputs(outputs, tile_shape, padding, offset):
    arrays = [np.asarray(output) for output in outputs]
    box_output = next((array for array in arrays if array.ndim == 3 and array.shape[1] == 2254 and array.shape[2] >= 12), None)
    score_output = next((array for array in arrays if array.ndim == 3 and array.shape[1] == 2254 and array.shape[2] == 1), None)
    if box_output is None or score_output is None:
        raise RuntimeError(f"人物检测模型输出不兼容：{[array.shape for array in arrays]}")
    scores = sigmoid(score_output[0, :, 0])
    selected = np.flatnonzero(scores >= SCORE_THRESHOLD)
    if not len(selected):
        return []
    deltas = box_output[0, selected]
    landmarks = deltas[:, 4:12].reshape(-1, 4, 2) / INPUT_SIZE
    landmarks += ANCHORS[selected, None, :]
    tile_height, tile_width = tile_shape
    scale = max(tile_width, tile_height)
    landmarks = landmarks * scale - padding[None, None, :]
    detections = []
    for score, points in zip(scores[selected], landmarks):
        hip_x, hip_y = points[0]
        full_x, full_y = points[1]
        radius = math.hypot(float(full_x - hip_x), float(full_y - hip_y))
        if not math.isfinite(radius) or radius < min(tile_width, tile_height) * 0.025:
            continue
        radius *= 1.12
        left, top = max(0.0, hip_x - radius), max(0.0, hip_y - radius)
        right, bottom = min(float(tile_width), hip_x + radius), min(float(tile_height), hip_y + radius)
        if right - left < 20 or bottom - top < 30:
            continue
        offset_x, offset_y = offset
        detections.append({"score": float(score), "box": [left + offset_x, top + offset_y, right + offset_x, bottom + offset_y]})
    return detections


def tile_regions(width, height):
    regions = [(0, 0, width, height)]
    if max(width, height) <= 2200:
        return regions
    tile_size = min(1600, width, height)
    stride = max(1, int(tile_size * 0.72))

    def starts(length):
        values = list(range(0, max(1, length - tile_size + 1), stride))
        final = max(0, length - tile_size)
        if not values or values[-1] != final:
            values.append(final)
        return values

    for top in starts(height):
        for left in starts(width):
            region = (left, top, min(width, left + tile_size), min(height, top + tile_size))
            if region not in regions:
                regions.append(region)
    return regions


def infer_tile(session, rgb, offset):
    blob, padding = preprocess(rgb)
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: blob})
    return decode_outputs(outputs, rgb.shape[:2], padding, offset)


def expanded_crop(box, image_width, image_height):
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    margin_x, margin_y = width * 0.1, height * 0.08
    crop_left = max(0, int(math.floor(left - margin_x)))
    crop_top = max(0, int(math.floor(top - margin_y)))
    crop_right = min(image_width, int(math.ceil(right + margin_x)))
    crop_bottom = min(image_height, int(math.ceil(bottom + margin_y)))
    return [crop_left, crop_top, max(1, crop_right - crop_left), max(1, crop_bottom - crop_top)]


def run_detection(session, rgb):
    height, width = rgb.shape[:2]
    detections = []
    for left, top, right, bottom in tile_regions(width, height):
        detections.extend(infer_tile(session, rgb[top:bottom, left:right], (left, top)))
    return nms(detections)


def detect(input_path, output_dir, preference="auto"):
    rgb = load_rgb(input_path)
    height, width = rgb.shape[:2]
    session, _providers, backend = create_session(preference)
    fallback_reason = ""
    try:
        detections = run_detection(session, rgb)
    except Exception as error:
        if preference != "auto" or backend != "gpu":
            raise
        fallback_reason = str(error)
        session, _providers, backend = create_session("cpu")
        detections = run_detection(session, rgb)
    tasks = []
    os.makedirs(output_dir, exist_ok=True)
    for index, detection in enumerate(detections, start=1):
        left, top, right, bottom = detection["box"]
        bbox = [max(0, int(left)), max(0, int(top)), max(1, int(right - left)), max(1, int(bottom - top))]
        crop = expanded_crop(detection["box"], width, height)
        crop_x, crop_y, crop_width, crop_height = crop
        task_id = str(uuid.uuid4())
        patch_path = os.path.join(output_dir, f"person-{index:02d}-{task_id}.png")
        Image.fromarray(rgb[crop_y:crop_y + crop_height, crop_x:crop_x + crop_width], "RGB").save(patch_path, format="PNG", compress_level=3)
        tasks.append({
            "id": task_id,
            "personIndex": index,
            "personName": f"人物 {index}",
            "assignee": "",
            "detector": "onnx-mediapipe-person",
            "confidence": detection["score"],
            "bbox": {"x": bbox[0], "y": bbox[1], "width": bbox[2], "height": bbox[3]},
            "crop": {"x": crop_x, "y": crop_y, "width": crop_width, "height": crop_height},
            "patchPath": patch_path,
            "status": "exported",
        })
    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as manifest:
        json.dump({"source": input_path, "width": width, "height": height, "tasks": tasks}, manifest, ensure_ascii=False, indent=2)
    return {
        "success": True,
        "detector": "onnx-mediapipe-person",
        "backend": backend,
        "provider": "DmlExecutionProvider" if backend == "gpu" else "CPUExecutionProvider",
        "fallbackReason": fallback_reason,
        "width": width,
        "height": height,
        "tasks": tasks,
        "manifestPath": manifest_path,
    }


def probe():
    providers = []
    cpu_available = False
    gpu_available = False
    errors = []
    merge_available = False
    try:
        from patch_merge import merge as _merge
        merge_available = callable(_merge)
    except Exception as error:
        errors.append(f"拼回引擎: {error}")
    try:
        session, providers, _backend = create_session("cpu")
        zero = np.zeros((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=np.float32)
        session.run(None, {session.get_inputs()[0].name: zero})
        cpu_available = True
    except Exception as error:
        errors.append(f"CPU: {error}")
    try:
        session, providers, _backend = create_session("gpu")
        zero = np.zeros((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=np.float32)
        session.run(None, {session.get_inputs()[0].name: zero})
        gpu_available = True
    except Exception as error:
        errors.append(f"GPU: {error}")
    return {"success": True, "componentAvailable": cpu_available and merge_available, "cpuAvailable": cpu_available, "gpuAvailable": gpu_available, "mergeAvailable": merge_available, "provider": "DmlExecutionProvider" if gpu_available else "CPUExecutionProvider" if cpu_available else "", "providers": providers, "error": "；".join(errors)}


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("probe", "detect", "merge"))
    parser.add_argument("--input")
    parser.add_argument("--output-dir")
    parser.add_argument("--manifest")
    parser.add_argument("--output")
    parser.add_argument("--provider", choices=("auto", "gpu", "cpu"), default="auto")
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
    if not args.input or not args.output_dir:
        parser.error("detect requires --input and --output-dir")
    emit(detect(os.path.abspath(args.input), os.path.abspath(args.output_dir), args.provider))


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
