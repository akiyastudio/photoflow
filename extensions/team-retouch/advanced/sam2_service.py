#!/usr/bin/env python3
"""SAM 2.1 CUDA inference service used by the production team-retouch component."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import tempfile
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import torch
from PIL import Image, ImageDraw
from image_safety import inspect_dimensions, open_validated
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor


COLORS = [
    (255, 99, 71),
    (64, 224, 208),
    (255, 215, 0),
    (138, 43, 226),
    (50, 205, 50),
    (30, 144, 255),
    (255, 105, 180),
    (255, 140, 0),
    (0, 206, 209),
    (220, 20, 60),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path)
    parser.add_argument("--boxes", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--max-image-edge", type=int, default=4096)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=Path.home() / "model-lab/checkpoints/sam2/sam2.1_hiera_large.pt",
    )
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def load_runtime(args: argparse.Namespace):
    device = torch.device("cuda:0")
    precision = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    verify_locked_checkpoint(args.checkpoint.resolve())
    model = build_sam2(
        "configs/sam2.1/sam2.1_hiera_l.yaml",
        str(args.checkpoint.resolve()),
        device=device,
        apply_postprocessing=False,
    )
    return SAM2ImagePredictor(model), device, precision


def verify_locked_checkpoint(checkpoint_path: Path):
    lock_path = Path.home() / "model-lab/release-locks/checkpoints.sha256"
    if not lock_path.is_file(): raise RuntimeError("Reviewed checkpoint SHA-256 lock is missing")
    expected = next((line.split()[0].lower() for line in lock_path.read_text(encoding="utf-8").splitlines() if line.strip() and line.split()[-1].lstrip("*").endswith(checkpoint_path.name)), "")
    if len(expected) != 64: raise RuntimeError(f"Checkpoint SHA-256 is not locked: {checkpoint_path.name}")
    digest = hashlib.sha256()
    with checkpoint_path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""): digest.update(chunk)
    if digest.hexdigest() != expected: raise RuntimeError(f"Checkpoint SHA-256 mismatch: {checkpoint_path.name}")


def infer_image(runtime, image_path: Path, boxes_path: Path, max_image_edge: int):
    predictor, device, precision = runtime
    original_size = inspect_dimensions(image_path, role="original")
    with open_validated(image_path, role="original", mode="RGB", max_edge=max_image_edge) as opened:
        source_image = opened.copy()
    proxy_scale = min(1.0, max_image_edge / max(original_size))
    image = np.asarray(source_image).copy()
    box_payload = json.loads(boxes_path.read_text(encoding="utf-8"))
    boxes = np.asarray(
        [item["box_xyxy"] for item in box_payload["boxes"]], dtype=np.float32
    )
    boxes *= proxy_scale
    if boxes.size == 0:
        raise RuntimeError("PairDETR produced no body boxes for SAM 2.1")

    torch.cuda.reset_peak_memory_stats(device)
    with torch.inference_mode(), torch.autocast("cuda", dtype=precision):
        predictor.set_image(image)
        masks, scores, _ = predictor.predict(box=boxes, multimask_output=False)
    torch.cuda.synchronize(device)

    if masks.ndim == 3:
        masks = masks[:, None, :, :]
    binary_masks = masks > 0.5
    mask_pixels = binary_masks[:, 0].reshape(len(masks), -1).sum(axis=1)
    report = {
        "device": torch.cuda.get_device_name(device),
        "torch": torch.__version__,
        "precision": "bf16" if precision == torch.bfloat16 else "fp16",
        "checkpoint": str(Path.home() / "model-lab/checkpoints/sam2/sam2.1_hiera_large.pt"),
        "original_image_size": list(original_size),
        "inference_image_shape": list(image.shape),
        "proxy_scale": proxy_scale,
        "prompt_boxes": int(len(boxes)),
        "mask_shape": list(masks.shape),
        "mask_scores": [round(float(value), 6) for value in scores.reshape(-1)],
        "mask_pixels": [int(value) for value in mask_pixels],
        "nonempty_masks": int((mask_pixels > 0).sum()),
        "finite_scores": bool(np.isfinite(scores).all()),
        "peak_gpu_mib": round(torch.cuda.max_memory_allocated(device) / 1024**2, 1),
    }
    if not report["finite_scores"] or report["nonempty_masks"] != len(boxes):
        raise RuntimeError("SAM 2.1 did not produce one valid mask per PairDETR box")
    return report, image, boxes, binary_masks, scores


def write_result(output_dir: Path | None, result):
    report, image, boxes, binary_masks, scores = result
    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)
        overlay = image.astype(np.float32)
        for index, mask in enumerate(binary_masks[:, 0]):
            color = np.asarray(COLORS[index % len(COLORS)], dtype=np.float32)
            overlay[mask] = overlay[mask] * 0.55 + color * 0.45
            Image.fromarray((mask.astype(np.uint8) * 255)).save(
                output_dir / f"mask-{index + 1:02d}.png"
            )
        overlay_image = Image.fromarray(np.clip(overlay, 0, 255).astype(np.uint8))
        draw = ImageDraw.Draw(overlay_image)
        for index, (box, score) in enumerate(zip(boxes, scores.reshape(-1))):
            color = COLORS[index % len(COLORS)]
            draw.rectangle(tuple(float(value) for value in box), outline=color, width=6)
            draw.text(
                (float(box[0]) + 8, float(box[1]) + 8),
                f"P{index + 1} {float(score):.3f}",
                fill=color,
                stroke_width=2,
                stroke_fill=(0, 0, 0),
            )
        overlay_image.save(output_dir / "overlay.jpg", quality=90)
        (output_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def serve(args: argparse.Namespace, runtime) -> None:
    print(json.dumps({"type": "ready", "protocolVersion": 1, "device": torch.cuda.get_device_name(runtime[1])}), flush=True)
    for line in __import__("sys").stdin:
        try:
            request = json.loads(line)
            if request.get("payload_b64"):
                request = json.loads(base64.b64decode(request["payload_b64"]).decode("utf-8"))
            if request.get("action") == "shutdown":
                print(json.dumps({"success": True, "requestId": request.get("requestId"), "protocolVersion": 1, "type": "stopped"}), flush=True)
                return
            if request.get("protocolVersion") != 1 or not request.get("requestId"):
                raise ValueError("protocolVersion=1 and requestId are required")
            result = infer_image(
                runtime, Path(request["image"]).resolve(), Path(request["boxes"]).resolve(),
                int(request.get("max_image_edge", args.max_image_edge)),
            )
            write_result(Path(request["output_dir"]).resolve(), result)
            print(json.dumps({"success": True, "requestId": request["requestId"], "protocolVersion": 1, "report": result[0]}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"success": False, "requestId": request.get("requestId") if isinstance(request, dict) else None, "protocolVersion": 1, "error": str(error)}, ensure_ascii=False), flush=True)


def main() -> None:
    args = parse_args()
    runtime = load_runtime(args)
    if args.self_test:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image_path = root / "self-test.png"; boxes_path = root / "boxes.json"
            pixels = np.zeros((64, 64, 3), dtype=np.uint8); pixels[16:48, 20:44] = 255
            Image.fromarray(pixels, "RGB").save(image_path)
            boxes_path.write_text(json.dumps({"boxes": [{"box_xyxy": [16, 12, 48, 52]}]}), encoding="utf-8")
            report = infer_image(runtime, image_path, boxes_path, 64)[0]
            if not report["finite_scores"] or report["nonempty_masks"] != 1:
                raise RuntimeError("SAM 2.1 self-test failed")
        print("SAM2_SELF_TEST_OK")
        return
    if args.serve:
        serve(args, runtime)
        return
    if args.image is None or args.boxes is None:
        raise ValueError("--image and --boxes are required unless --serve is used")
    result = infer_image(runtime, args.image, args.boxes, args.max_image_edge)
    print(json.dumps(result[0], ensure_ascii=False, indent=2))
    write_result(args.output_dir, result)


if __name__ == "__main__":
    main()
