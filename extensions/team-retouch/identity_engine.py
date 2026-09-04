"""Local face/body identity descriptors and constrained clustering.

Face identity is the primary signal. OSNet appearance embeddings are used as
supporting evidence for small, profile, occluded, or missing faces. Automatic
groups remain candidates; manually confirmed assignments are hard constraints.
"""

from __future__ import annotations

import math
import os
from pathlib import Path

import cv2
import numpy as np


FACE_DETECTOR_MODEL = "face_detection_yunet_2023mar.onnx"
FACE_RECOGNIZER_MODEL = "adaface_ir18_webface4m.onnx"
BODY_REID_MODEL = "osnet_x1_0_msmt17.onnx"
ADAFACE_LANDMARK_TEMPLATE = np.asarray([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
], dtype=np.float32)


def _model_path(model_directory, file_name, minimum_size, environment_name, development_subdirectory):
    candidates = [Path(model_directory) / file_name]
    configured = os.environ.get(environment_name)
    if configured:
        candidates.append(Path(configured))
    try:
        candidates.append(Path(model_directory).parents[2] / ".cache" / "model-lab" / development_subdirectory / file_name)
    except IndexError:
        pass
    model_path = next((path for path in candidates if path.is_file() and path.stat().st_size >= minimum_size), None)
    if model_path is None:
        raise RuntimeError(f"人物身份识别模型缺失或不完整：{file_name}")
    return model_path


def _align_face(source_bgr, raw_face):
    landmarks = np.asarray(raw_face[4:14], dtype=np.float32).reshape(5, 2)
    transform, _inliers = cv2.estimateAffinePartial2D(landmarks, ADAFACE_LANDMARK_TEMPLATE, method=cv2.LMEDS)
    if transform is None:
        x, y, width, height = (float(value) for value in raw_face[:4])
        x1, y1 = max(0, int(x)), max(0, int(y))
        x2, y2 = min(source_bgr.shape[1], int(x + width)), min(source_bgr.shape[0], int(y + height))
        return cv2.resize(source_bgr[y1:y2, x1:x2], (112, 112), interpolation=cv2.INTER_AREA)
    return cv2.warpAffine(source_bgr, transform, (112, 112), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def _unit(vector):
    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    return vector / max(norm, 1e-8)


def _cosine(left, right):
    return float(np.clip(np.dot(left, right), -1, 1))


def _clamp_bbox(raw, width, height):
    x1 = max(0, min(width - 1, int(math.floor(float(raw.get("x", 0))))))
    y1 = max(0, min(height - 1, int(math.floor(float(raw.get("y", 0))))))
    x2 = max(x1 + 1, min(width, int(math.ceil(float(raw.get("x", 0)) + float(raw.get("width", 1))))))
    y2 = max(y1 + 1, min(height, int(math.ceil(float(raw.get("y", 0)) + float(raw.get("height", 1))))))
    return x1, y1, x2, y2


def _intersection_over_smaller(left, right):
    lx1, ly1, lx2, ly2 = left
    rx1, ry1, rx2, ry2 = right
    intersection = max(0, min(lx2, rx2) - max(lx1, rx1)) * max(0, min(ly2, ry2) - max(ly1, ry1))
    smaller = min(max(1, (lx2 - lx1) * (ly2 - ly1)), max(1, (rx2 - rx1) * (ry2 - ry1)))
    return intersection / smaller


def select_onnx_providers(available, requested):
    available = list(available)
    if requested == "gpu" and "DmlExecutionProvider" not in available:
        raise RuntimeError(f"DirectML GPU 不可用；当前运行库提供：{', '.join(available) or '无'}")
    return ["DmlExecutionProvider", "CPUExecutionProvider"] if requested != "cpu" and "DmlExecutionProvider" in available else ["CPUExecutionProvider"]


def create_identity_sessions(ort, body_path, face_path, requested):
    available = ort.get_available_providers(); providers = select_onnx_providers(available, requested)
    def options_for(values):
        options = ort.SessionOptions()
        if values[0] == "DmlExecutionProvider":
            options.enable_mem_pattern = False; options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        return options
    try:
        options = options_for(providers)
        return (ort.InferenceSession(str(body_path), sess_options=options, providers=providers),
                ort.InferenceSession(str(face_path), sess_options=options, providers=providers), "")
    except Exception as error:
        if requested != "auto" or providers == ["CPUExecutionProvider"]:
            raise
        providers = ["CPUExecutionProvider"]; options = options_for(providers)
        return (ort.InferenceSession(str(body_path), sess_options=options, providers=providers),
                ort.InferenceSession(str(face_path), sess_options=options, providers=providers),
                f"DirectML 初始化失败，已从原始输入切换 CPU：{error}")


class IdentityRuntime:
    def __init__(self, model_directory, provider="auto"):
        model_directory = Path(model_directory)
        face_detector_path = model_directory / FACE_DETECTOR_MODEL
        if not face_detector_path.is_file() or face_detector_path.stat().st_size < 200_000:
            raise RuntimeError(f"人物身份识别模型缺失或不完整：{FACE_DETECTOR_MODEL}")
        face_recognizer_path = _model_path(model_directory, FACE_RECOGNIZER_MODEL, 20_000_000, "PHOTOFLOW_ADAFACE_MODEL", "adaface")
        body_reid_path = _model_path(model_directory, BODY_REID_MODEL, 2_000_000, "PHOTOFLOW_OSNET_MODEL", "osnet")

        # Candidate filtering is constrained by the detected body and expected
        # head position, so a lower detector threshold recovers difficult faces
        # without accepting arbitrary faces elsewhere in the photograph.
        self.face_detector = cv2.FaceDetectorYN_create(str(face_detector_path), "", (320, 320), .52, .3, 5000)

        try:
            import onnxruntime as ort
        except ImportError as error:
            raise RuntimeError("人物身份识别缺少 ONNX Runtime") from error
        self.body_session, self.adaface_session, self.fallback_reason = create_identity_sessions(ort, body_reid_path, face_recognizer_path, provider)
        self.body_input_name = self.body_session.get_inputs()[0].name
        self.adaface_input_name = self.adaface_session.get_inputs()[0].name
        self.adaface_output_count = len(self.adaface_session.get_outputs())
        self.provider = self.body_session.get_providers()[0]
        self.body_backend = "osnet-x1"
        self.face_backend = "adaface-ir18"

    def _face_feature(self, aligned):
        tensor = aligned.astype(np.float32) / 127.5 - 1.0
        tensor = np.ascontiguousarray(tensor.transpose(2, 0, 1)[None])
        outputs = self.adaface_session.run(None, {self.adaface_input_name: tensor})
        embedding = outputs[0]
        feature_norm = outputs[1] if self.adaface_output_count > 1 else np.linalg.norm(embedding, axis=1, keepdims=True)
        norm_quality = float(np.clip((float(np.asarray(feature_norm).reshape(-1)[0]) - 5) / 20, 0, 1)) if self.adaface_output_count > 1 else .5
        return _unit(embedding[0]), norm_quality

    def _detect_faces(self, source_bgr, region, target_edge, maximum_upscale):
        image_height, image_width = source_bgr.shape[:2]
        x1, y1, x2, y2 = region
        x1, y1 = max(0, int(x1)), max(0, int(y1))
        x2, y2 = min(image_width, int(x2)), min(image_height, int(y2))
        crop = source_bgr[y1:y2, x1:x2]
        if crop.shape[0] < 20 or crop.shape[1] < 20:
            return []
        scale = min(float(maximum_upscale), float(target_edge) / max(crop.shape[:2]))
        detection_image = crop if abs(scale - 1) < 1e-3 else cv2.resize(
            crop, None, fx=scale, fy=scale,
            interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA,
        )
        self.face_detector.setInputSize((detection_image.shape[1], detection_image.shape[0]))
        _status, faces = self.face_detector.detect(detection_image)
        mapped = []
        for raw_face in faces if faces is not None else []:
            face = np.asarray(raw_face, dtype=np.float32).copy()
            face[0], face[1] = face[0] / scale + x1, face[1] / scale + y1
            face[2], face[3] = face[2] / scale, face[3] / scale
            for offset in range(4, 14, 2):
                face[offset], face[offset + 1] = face[offset] / scale + x1, face[offset + 1] / scale + y1
            mapped.append(face)
        return mapped

    def _face_descriptor(self, rgb, item):
        height, width = rgb.shape[:2]
        bx1, by1, bx2, by2 = _clamp_bbox(item.get("bbox") or {}, width, height)
        body_width, body_height = bx2 - bx1, by2 - by1
        expand_x = round(body_width * .08)
        expand_top = round(body_height * .08)
        rx1, ry1 = max(0, bx1 - expand_x), max(0, by1 - expand_top)
        rx2, ry2 = min(width, bx2 + expand_x), min(height, by2 + round(body_height * .03))
        if ry2 - ry1 < 20 or rx2 - rx1 < 20:
            return None, 0.0, None
        source_bgr = np.ascontiguousarray(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        supplied = item.get("faceBox") or {}
        supplied_center = None
        if supplied:
            supplied_center = (
                float(supplied.get("x", 0)) + float(supplied.get("width", 0)) / 2,
                float(supplied.get("y", 0)) + float(supplied.get("height", 0)) / 2,
            )

        regions = [((rx1, ry1, rx2, ry2), 1280, 1.0)]
        head_margin_x = round(body_width * .14)
        regions.append(((bx1 - head_margin_x, by1 - expand_top, bx2 + head_margin_x, by1 + body_height * .62), 1100, 2.5))
        if supplied and float(supplied.get("width", 0)) >= 12 and float(supplied.get("height", 0)) >= 12:
            face_width = float(supplied["width"])
            face_height = float(supplied["height"])
            face_x = float(supplied.get("x", 0))
            face_y = float(supplied.get("y", 0))
            regions.append(((face_x - face_width, face_y - face_height, face_x + face_width * 2, face_y + face_height * 2), 560, 4.0))

        candidates = []
        faces = [face for region, target_edge, maximum_upscale in regions for face in self._detect_faces(source_bgr, region, target_edge, maximum_upscale)]
        for face in faces:
            x, y, face_width, face_height = (float(value) for value in face[:4])
            center_x, center_y = x + face_width / 2, y + face_height / 2
            if not (bx1 <= center_x <= bx2 and by1 - body_height * .05 <= center_y <= by1 + body_height * .68):
                continue
            detector_score = float(face[14])
            area_score = min(1.0, math.sqrt(max(1, face_width * face_height)) / 100)
            target_score = 0.0
            if supplied_center:
                distance = math.hypot(center_x - supplied_center[0], center_y - supplied_center[1])
                target_score = max(0.0, 1 - distance / max(20, math.hypot(face_width, face_height) * 2))
            expected_x, expected_y = (bx1 + bx2) / 2, by1 + body_height * .16
            anatomy_distance = math.hypot((center_x - expected_x) / max(1, body_width), (center_y - expected_y) / max(1, body_height))
            anatomy_score = max(0.0, 1 - anatomy_distance / .58)
            candidates.append((.46 * detector_score + .22 * area_score + .18 * target_score + .14 * anatomy_score, face))

        if candidates:
            face = max(candidates, key=lambda candidate: candidate[0])[1]
            aligned = _align_face(source_bgr, face)
            feature, model_quality = self._face_feature(aligned)
            face_width, face_height = float(face[2]), float(face[3])
            sharpness = float(cv2.Laplacian(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), cv2.CV_32F).var())
            contrast = float(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY).std())
            quality = (
                .35 * float(face[14])
                + .3 * min(1.0, min(face_width, face_height) / 90)
                + .2 * min(1.0, sharpness / 180)
                + .15 * min(1.0, contrast / 58)
            )
            if model_quality is not None:
                quality = .82 * quality + .18 * model_quality
            face_box = {
                "x": int(round(float(face[0]))),
                "y": int(round(float(face[1]))),
                "width": max(1, int(round(face_width))),
                "height": max(1, int(round(face_height))),
            }
            return feature, float(np.clip(quality, 0, 1)), face_box

        if supplied and float(supplied.get("width", 0)) >= 20 and float(supplied.get("height", 0)) >= 20:
            fx1, fy1, fx2, fy2 = _clamp_bbox(supplied, width, height)
            face_crop = cv2.cvtColor(rgb[fy1:fy2, fx1:fx2], cv2.COLOR_RGB2BGR)
            aligned = cv2.resize(face_crop, (112, 112), interpolation=cv2.INTER_AREA)
            feature, model_quality = self._face_feature(aligned)
            size_quality = min(1.0, min(fx2 - fx1, fy2 - fy1) / 100)
            gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
            contrast_quality = min(1.0, float(gray.std()) / 42.0)
            sharpness_quality = min(1.0, float(cv2.Laplacian(gray, cv2.CV_32F).var()) / 140.0)
            quality = (.18 + .2 * size_quality) * contrast_quality * (.35 + .65 * sharpness_quality)
            if model_quality is not None:
                quality = .9 * quality + .1 * model_quality * contrast_quality
            return feature, float(np.clip(quality, 0, 1)), {"x": fx1, "y": fy1, "width": fx2 - fx1, "height": fy2 - fy1}
        return None, 0.0, None

    def _body_input(self, rgb, item):
        height, width = rgb.shape[:2]
        x1, y1, x2, y2 = _clamp_bbox(item.get("bbox") or {}, width, height)
        crop = rgb[y1:y2, x1:x2]
        resized = cv2.resize(crop, (128, 256), interpolation=cv2.INTER_AREA if crop.shape[0] > 256 else cv2.INTER_LINEAR)
        tensor = resized.astype(np.float32) / 255
        tensor = (tensor - np.asarray([.485, .456, .406], dtype=np.float32)) / np.asarray([.229, .224, .225], dtype=np.float32)
        body_height, body_width = y2 - y1, x2 - x1
        resolution = min(1.0, body_height / 600) * .65 + min(1.0, body_width / 240) * .35
        aspect = body_width / max(1, body_height)
        aspect_quality = max(.35, 1 - abs(aspect - .42) / .65)
        clipped_edges = sum((x1 <= 1, y1 <= 1, x2 >= width - 1, y2 >= height - 1))
        completeness = max(.35, 1 - clipped_edges * .14)
        occlusion = float(item.get("occlusion") or 0)
        appearance_std = float(cv2.cvtColor(resized, cv2.COLOR_RGB2GRAY).std())
        texture_quality = float(np.clip((appearance_std - 2.0) / 22.0, 0, 1))
        quality = resolution * aspect_quality * completeness * max(.35, 1 - occlusion * .65) * texture_quality
        return np.ascontiguousarray(tensor.transpose(2, 0, 1)), float(np.clip(quality, 0, 1))

    def describe(self, rgb, item):
        face, face_quality, detected_face_box = self._face_descriptor(rgb, item)
        body_input, body_quality = self._body_input(rgb, item)
        return {
            "key": item["key"],
            "photoId": str(item.get("photoId") or ""),
            "manualIdentityId": item.get("manualIdentityId") or None,
            "face": face,
            "faceQuality": face_quality,
            "faceBackend": self.face_backend,
            "faceBox": detected_face_box,
            "bodyInput": body_input,
            "bodyQuality": body_quality,
        }

    def embed_bodies(self, descriptors, batch_size=12):
        for start in range(0, len(descriptors), batch_size):
            batch_items = descriptors[start:start + batch_size]
            inputs = [item.pop("bodyInput") for item in batch_items]
            # Test-time horizontal flip ensembling is cheap relative to model
            # startup and makes appearance embeddings less pose-directional.
            batch = np.stack([variant for item in inputs for variant in (item, np.ascontiguousarray(item[:, :, ::-1]))]).astype(np.float32)
            embeddings = self.body_session.run(None, {self.body_input_name: batch})[0]
            embeddings = embeddings.reshape(len(batch_items), 2, -1)
            for item, embedding_pair in zip(batch_items, embeddings):
                item["body"] = _unit(_unit(embedding_pair[0]) + _unit(embedding_pair[1]))
                item["bodyBackend"] = self.body_backend


def add_occlusion_estimates(subjects, image_shapes):
    by_photo = {}
    for subject in subjects:
        by_photo.setdefault(str(subject.get("photoId") or ""), []).append(subject)
    for photo_id, photo_subjects in by_photo.items():
        height, width = image_shapes[photo_id]
        boxes = [_clamp_bbox(subject.get("bbox") or {}, width, height) for subject in photo_subjects]
        for index, subject in enumerate(photo_subjects):
            subject["occlusion"] = max((_intersection_over_smaller(boxes[index], other) for other_index, other in enumerate(boxes) if other_index != index), default=0.0)


def pair_metrics(left, right):
    body_score = _cosine(left["body"], right["body"])
    face_score = None
    face_quality = min(float(left["faceQuality"]), float(right["faceQuality"]))
    if left.get("face") is not None and right.get("face") is not None:
        face_score = _cosine(left["face"], right["face"])

    body_confidence = float(np.clip((body_score - .38) / .48, 0, 1))
    using_adaface = str(left.get("faceBackend") or "").startswith("adaface") and str(right.get("faceBackend") or "").startswith("adaface")
    contradiction_threshold = .06 if using_adaface else .16
    contradiction = face_score is not None and face_quality >= .56 and face_score < contradiction_threshold
    if face_score is not None:
        face_confidence = float(np.clip((face_score - (.10 if using_adaface else .18)) / (.52 if using_adaface else .40), 0, 1))
        face_weight = .72 + .18 * face_quality
        score = face_weight * face_confidence + (1 - face_weight) * body_confidence
        if using_adaface and face_quality >= .56:
            qualifies = face_score >= .36 or face_score >= .27 and body_score >= .64
        elif using_adaface:
            qualifies = face_score >= .41 or face_score >= .31 and body_score >= .67
        elif face_quality >= .56:
            qualifies = face_score >= .43 or face_score >= .33 and body_score >= .64
        else:
            qualifies = face_score >= .47 or face_score >= .37 and body_score >= .67
        evidence = "face+body"
    else:
        quality = min(float(left["bodyQuality"]), float(right["bodyQuality"]))
        score = body_confidence * (.72 + .28 * quality)
        qualifies = quality >= .32 and body_score >= .79
        evidence = "body-only"
    return {
        "score": float(np.clip(score, 0, 1)),
        "faceScore": face_score,
        "bodyScore": body_score,
        "qualifies": bool(qualifies and not contradiction),
        "contradiction": bool(contradiction),
        "evidence": evidence,
        "faceQuality": face_quality,
    }


class CompactPairMetrics:
    """Triangular numeric cache with bounded memory and dict-compatible access."""
    def __init__(self, subject_count):
        self.subject_count = int(subject_count)
        pair_count = self.subject_count * (self.subject_count - 1) // 2
        self.values = np.zeros((pair_count, 4), dtype=np.float32)
        self.flags = np.zeros(pair_count, dtype=np.uint8)

    def _index(self, key):
        left, right = sorted((int(key[0]), int(key[1])))
        if left == right or left < 0 or right >= self.subject_count:
            raise KeyError(key)
        return left * (2 * self.subject_count - left - 1) // 2 + right - left - 1

    def __contains__(self, key):
        return bool(self.flags[self._index(key)] & 1)

    def mark_skipped(self, key):
        self.flags[self._index(key)] = 1 | 16

    def __setitem__(self, key, value):
        index = self._index(key)
        self.values[index] = (
            float(value["score"]),
            float(value["faceScore"]) if value["faceScore"] is not None else np.nan,
            float(value["bodyScore"]),
            float(value.get("faceQuality", 0)),
        )
        evidence = 2 if value.get("evidence") == "face+body" else 0
        self.flags[index] = 1 | evidence | (4 if value.get("qualifies") else 0) | (8 if value.get("contradiction") else 0)

    def __getitem__(self, key):
        index = self._index(key)
        flags = int(self.flags[index])
        if not flags & 1:
            raise KeyError(key)
        if flags & 16:
            return {"skipped": True, "score": 0.0, "faceScore": None, "bodyScore": 0.0,
                    "faceQuality": 0.0, "qualifies": False, "contradiction": False, "evidence": "same-image"}
        score, face_score, body_score, face_quality = self.values[index]
        return {
            "score": float(score),
            "faceScore": None if np.isnan(face_score) else float(face_score),
            "bodyScore": float(body_score),
            "faceQuality": float(face_quality),
            "qualifies": bool(flags & 4),
            "contradiction": bool(flags & 8),
            "evidence": "face+body" if flags & 2 else "body-only",
        }


def ranked_similarity_pairs(descriptors, limit_per_subject=32, metrics_cache=None):
    """Return a compact symmetric top-k cache for interactive candidate ranking."""
    if len(descriptors) < 2:
        return []
    ranked = [[] for _item in descriptors]
    metrics_cache = metrics_cache if metrics_cache is not None else {}
    def metric(left_index, right_index):
        key = (min(left_index, right_index), max(left_index, right_index))
        if key not in metrics_cache:
            metrics_cache[key] = pair_metrics(descriptors[key[0]], descriptors[key[1]])
        return metrics_cache[key]
    for left_index in range(len(descriptors)):
        for right_index in range(left_index + 1, len(descriptors)):
            left, right = descriptors[left_index], descriptors[right_index]
            if left["photoId"] == right["photoId"]:
                continue
            metrics = metric(left_index, right_index)
            ranked[left_index].append((metrics["score"], right_index, metrics))
            ranked[right_index].append((metrics["score"], left_index, metrics))
    selected = set()
    for source_index, candidates in enumerate(ranked):
        for _score, target_index, _metrics in sorted(candidates, reverse=True)[:limit_per_subject]:
            selected.add((min(source_index, target_index), max(source_index, target_index)))
    results = []
    for left_index, right_index in sorted(selected):
        metrics = metric(left_index, right_index)
        results.append({
            "leftKey": descriptors[left_index]["key"],
            "rightKey": descriptors[right_index]["key"],
            "score": round(float(metrics["score"]), 4),
            "faceScore": round(float(metrics["faceScore"]), 4) if metrics["faceScore"] is not None else None,
            "bodyScore": round(float(metrics["bodyScore"]), 4),
            "evidence": metrics["evidence"],
        })
    return results


def constrained_clusters(descriptors, metrics_cache=None):
    if not descriptors:
        return []
    metrics = metrics_cache if metrics_cache is not None else {}
    for left in range(len(descriptors)):
        for right in range(left + 1, len(descriptors)):
            if descriptors[left]["photoId"] == descriptors[right]["photoId"]:
                if hasattr(metrics, "mark_skipped"):
                    metrics.mark_skipped((left, right))
                continue
            if (left, right) not in metrics:
                metrics[(left, right)] = pair_metrics(descriptors[left], descriptors[right])

    def metric(left, right):
        return metrics[(min(left, right), max(left, right))]

    clusters = [{"members": [index], "photos": {descriptors[index]["photoId"]}, "manual": {descriptors[index]["manualIdentityId"]} - {None}, "galleryMatched": False} for index in range(len(descriptors))]

    # Human-confirmed examples of one identity form a gallery before automatic
    # matching. Same-photo exclusivity remains authoritative.
    changed = True
    while changed:
        changed = False
        for left_index in range(len(clusters)):
            for right_index in range(left_index + 1, len(clusters)):
                left, right = clusters[left_index], clusters[right_index]
                if left["photos"] & right["photos"] or not left["manual"] or left["manual"] != right["manual"]:
                    continue
                left["members"].extend(right["members"])
                left["photos"] |= right["photos"]
                clusters.pop(right_index)
                changed = True
                break
            if changed:
                break

    # Match unconfirmed subjects against human-confirmed galleries first. A
    # subject may match the best few views instead of every gallery image, but
    # ambiguous matches and strong high-quality face contradictions are held
    # back for review.
    while True:
        best_attachment = None
        for candidate_index, candidate in enumerate(clusters):
            if candidate["manual"]:
                continue
            options = []
            for gallery_index, gallery in enumerate(clusters):
                if not gallery["manual"] or candidate["photos"] & gallery["photos"]:
                    continue
                cross = [metric(member, reference) for member in candidate["members"] for reference in gallery["members"]]
                if any(item["contradiction"] for item in cross):
                    continue
                covered = []
                for member in candidate["members"]:
                    matches = [metric(member, reference) for reference in gallery["members"]]
                    qualified = sorted((item for item in matches if item["qualifies"]), key=lambda item: item["score"], reverse=True)
                    if not qualified:
                        covered = []
                        break
                    covered.append(qualified[0])
                if not covered:
                    continue
                strongest = sorted(covered, key=lambda item: item["score"], reverse=True)[:3]
                gallery_score = float(np.mean([item["score"] for item in strongest]))
                face_supported = any(item["evidence"] == "face+body" for item in strongest)
                minimum_score = .56 if face_supported else .72
                if gallery_score >= minimum_score:
                    options.append((gallery_score, gallery_index))
            if not options:
                continue
            options.sort(reverse=True)
            score, gallery_index = options[0]
            margin = score - options[1][0] if len(options) > 1 else 1.0
            if margin < .055:
                continue
            if best_attachment is None or score > best_attachment[0]:
                best_attachment = (score, candidate_index, gallery_index)
        if best_attachment is None:
            break
        _score, candidate_index, gallery_index = best_attachment
        candidate, gallery = clusters[candidate_index], clusters[gallery_index]
        gallery["members"].extend(candidate["members"])
        gallery["photos"] |= candidate["photos"]
        gallery["galleryMatched"] = True
        clusters.pop(candidate_index)

    while True:
        best = None
        for left_index in range(len(clusters)):
            for right_index in range(left_index + 1, len(clusters)):
                left, right = clusters[left_index], clusters[right_index]
                if left["photos"] & right["photos"] or len(left["manual"] | right["manual"]) > 1:
                    continue
                if bool(left["manual"]) != bool(right["manual"]):
                    # Manual galleries were handled above with ambiguity-margin
                    # checks. Do not bypass those checks in generic clustering.
                    continue
                cross = [(a, b, metric(a, b)) for a in left["members"] for b in right["members"]]
                if any(item[2]["contradiction"] for item in cross):
                    continue
                left_coverage = [max((item[2]["score"] for item in cross if item[0] == member and item[2]["qualifies"]), default=-1) for member in left["members"]]
                right_coverage = [max((item[2]["score"] for item in cross if item[1] == member and item[2]["qualifies"]), default=-1) for member in right["members"]]
                if min(left_coverage + right_coverage) < 0:
                    continue
                merge_score = min(left_coverage + right_coverage)
                if best is None or merge_score > best[0]:
                    best = (merge_score, left_index, right_index)
        if best is None:
            break
        _score, left_index, right_index = best
        left, right = clusters[left_index], clusters[right_index]
        left["members"].extend(right["members"])
        left["photos"] |= right["photos"]
        left["manual"] |= right["manual"]
        clusters.pop(right_index)

    results = []
    for cluster in clusters:
        if len(cluster["members"]) < 2:
            continue
        pair_values = [metric(left, right) for offset, left in enumerate(cluster["members"]) for right in cluster["members"][offset + 1:] if descriptors[left]["photoId"] != descriptors[right]["photoId"]]
        supporting = [item for item in pair_values if item["qualifies"]]
        score = min((item["score"] for item in supporting), default=.65)
        face_supported = bool(supporting) and all(item["evidence"] == "face+body" and item.get("faceQuality", 0) >= .45 for item in supporting)
        results.append({
            "confidence": "high" if face_supported and score >= .78 else "suggested",
            "score": round(float(score), 4),
            "members": [{"key": descriptors[index]["key"]} for index in cluster["members"]],
            "evidence": "manual-gallery" if cluster["galleryMatched"] else "face+osnet" if face_supported else "osnet-assisted",
        })
    return sorted(results, key=lambda item: (-len(item["members"]), -item["score"]))
