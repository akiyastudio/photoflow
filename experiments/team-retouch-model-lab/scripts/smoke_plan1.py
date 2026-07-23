#!/usr/bin/env python3
"""Run YuNet and the exported RTMDet-Ins model on one real image."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np
import torch

_TORCH_LIB = Path(torch.__file__).resolve().parent / "lib"
_TORCH_DLL_DIRECTORY = os.add_dll_directory(str(_TORCH_LIB))
import onnxruntime as ort  # noqa: E402

ort.preload_dlls(directory=str(_TORCH_LIB))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--score-threshold", type=float, default=0.30)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--max-overlay-edge", type=int, default=4096)
    return parser.parse_args()


def make_session(path: Path) -> ort.InferenceSession:
    session = ort.InferenceSession(
        str(path), providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
    )
    if "CUDAExecutionProvider" not in session.get_providers():
        raise RuntimeError(f"CUDA provider was not activated for {path}")
    return session


def letterbox_bgr(image: np.ndarray, size: int = 640) -> tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    scale = min(size / width, size / height)
    resized_width = round(width * scale)
    resized_height = round(height * scale)
    resized = cv2.resize(image, (resized_width, resized_height))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[:resized_height, :resized_width] = resized
    mean = np.asarray([103.53, 116.28, 123.675], dtype=np.float32)
    std = np.asarray([57.375, 57.12, 58.395], dtype=np.float32)
    tensor = (canvas.astype(np.float32) - mean) / std
    return np.ascontiguousarray(tensor.transpose(2, 0, 1)[None]), scale


def make_pose_batch(
    image: np.ndarray, boxes_xyxy: np.ndarray, scale: float
) -> np.ndarray:
    height, width = image.shape[:2]
    crops: list[np.ndarray] = []
    pose_mean = np.asarray([123.675, 116.28, 103.53], dtype=np.float32)
    pose_std = np.asarray([58.395, 57.12, 57.375], dtype=np.float32)
    for box in boxes_xyxy:
        x1, y1, x2, y2 = box / scale
        left = max(0, min(width - 1, int(np.floor(x1))))
        top = max(0, min(height - 1, int(np.floor(y1))))
        right = max(left + 1, min(width, int(np.ceil(x2))))
        bottom = max(top + 1, min(height, int(np.ceil(y2))))
        crop = image[top:bottom, left:right]
        if crop.size == 0:
            continue
        crop = cv2.resize(crop, (192, 256), interpolation=cv2.INTER_LINEAR)
        crop = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32)
        crop = (crop - pose_mean) / pose_std
        crops.append(crop.transpose(2, 0, 1))
    if not crops:
        raise RuntimeError("RTMDet produced no valid person crops for RTMPose")
    return np.ascontiguousarray(np.stack(crops))


def main() -> None:
    args = parse_args()
    model_root = args.workspace.resolve() / ".model-lab/models/plan1"
    image = cv2.imread(str(args.image.resolve()))
    if image is None:
        raise FileNotFoundError(args.image)

    height, width = image.shape[:2]
    yunet_path = model_root / "yunet/face_detection_yunet_2023mar.onnx"
    detector = cv2.FaceDetectorYN.create(
        str(yunet_path), "", (width, height), 0.60, 0.30, 5000
    )
    _, faces = detector.detect(image)
    face_count = 0 if faces is None else int(len(faces))

    rtmdet_path = model_root / "rtmdet-ins/rtmdet-ins_m_640x640.onnx"
    session = make_session(rtmdet_path)
    tensor, scale = letterbox_bgr(image)
    raw_outputs = session.run(None, {session.get_inputs()[0].name: tensor})
    by_name = dict(zip((item.name for item in session.get_outputs()), raw_outputs))
    dets = by_name["dets"][0]
    labels = by_name["labels"][0]
    masks = by_name["masks"]
    scores = dets[:, 4]
    keep = scores >= args.score_threshold
    people = keep & (labels == 0)
    person_boxes = []
    for detection in dets[people]:
        x1, y1, x2, y2 = detection[:4] / scale
        person_boxes.append(
            {
                "box_xyxy": [
                    round(float(max(0, min(width - 1, x1))), 2),
                    round(float(max(0, min(height - 1, y1))), 2),
                    round(float(max(0, min(width - 1, x2))), 2),
                    round(float(max(0, min(height - 1, y2))), 2),
                ],
                "score": round(float(detection[4]), 6),
            }
        )

    pose_path = (
        model_root
        / "rtmpose/rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192-4d3e73dd_20230605.onnx"
    )
    pose_session = make_session(pose_path)
    pose_batch = make_pose_batch(image, dets[people, :4], scale)
    pose_outputs = pose_session.run(
        None, {pose_session.get_inputs()[0].name: pose_batch}
    )

    report = {
        "device_provider": session.get_providers()[0],
        "image_shape": [height, width],
        "rtmdet_input_shape": list(tensor.shape),
        "letterbox_scale": scale,
        "yunet_faces": face_count,
        "rtmdet_detections": int(keep.sum()),
        "rtmdet_people": int(people.sum()),
        "person_boxes": person_boxes,
        "rtmdet_top_person_scores": [
            round(float(value), 4)
            for value in np.sort(scores[labels == 0])[::-1][:12]
        ],
        "rtmpose_batch_shape": list(pose_batch.shape),
        "rtmpose_output_shapes": [list(value.shape) for value in pose_outputs],
        "output_shapes": {
            "dets": list(by_name["dets"].shape),
            "labels": list(by_name["labels"].shape),
            "masks": list(masks.shape),
        },
        "finite": all(
            bool(np.isfinite(value).all())
            for value in [*raw_outputs, *pose_outputs]
        ),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.output_dir is not None:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        overlay_scale = min(1.0, args.max_overlay_edge / max(width, height))
        overlay_width = round(width * overlay_scale)
        overlay_height = round(height * overlay_scale)
        overlay = cv2.resize(image, (overlay_width, overlay_height))
        selected_dets = dets[people]
        selected_masks = masks[0, people]
        valid_width = round(width * scale)
        valid_height = round(height * scale)
        colors = [
            (71, 99, 255),
            (208, 224, 64),
            (0, 215, 255),
            (226, 43, 138),
            (50, 205, 50),
            (255, 144, 30),
            (180, 105, 255),
            (0, 140, 255),
            (209, 206, 0),
            (60, 20, 220),
        ]
        for index, (detection, mask) in enumerate(
            zip(selected_dets, selected_masks)
        ):
            color = colors[index % len(colors)]
            valid_mask = mask[:valid_height, :valid_width]
            proxy_mask = cv2.resize(
                valid_mask,
                (overlay_width, overlay_height),
                interpolation=cv2.INTER_LINEAR,
            ) >= 0.5
            overlay[proxy_mask] = (
                overlay[proxy_mask].astype(np.float32) * 0.55
                + np.asarray(color, dtype=np.float32) * 0.45
            ).astype(np.uint8)
            x1, y1, x2, y2 = detection[:4] / scale * overlay_scale
            cv2.rectangle(
                overlay,
                (round(x1), round(y1)),
                (round(x2), round(y2)),
                color,
                6,
            )
            cv2.putText(
                overlay,
                f"P{index + 1} {detection[4]:.3f}",
                (round(x1) + 8, round(y1) + 32),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.9,
                color,
                2,
                cv2.LINE_AA,
            )
            cv2.imwrite(
                str(args.output_dir / f"mask-{index + 1:02d}.png"),
                proxy_mask.astype(np.uint8) * 255,
            )
        cv2.imwrite(str(args.output_dir / "overlay.jpg"), overlay)
        (args.output_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    if not report["finite"]:
        raise RuntimeError("RTMDet-Ins produced non-finite outputs")


if __name__ == "__main__":
    main()
