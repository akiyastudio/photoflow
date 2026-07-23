#!/usr/bin/env python3
"""Load the pinned PairDETR checkpoint and run one real CUDA inference."""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import torch
from PIL import Image
from torchvision.ops import nms

Image.MAX_IMAGE_PIXELS = None
from transformers import AutoImageProcessor, DeformableDetrConfig
from transformers import DeformableDetrForObjectDetection


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--checkpoint-dir",
        type=Path,
        default=Path.home() / "model-lab/checkpoints/pairdetr",
    )
    parser.add_argument("--image", type=Path)
    parser.add_argument("--boxes-output", type=Path)
    parser.add_argument("--pair-threshold", type=float, default=0.50)
    parser.add_argument("--nms-iou", type=float, default=0.90)
    parser.add_argument("--shortest-edge", type=int, default=480)
    parser.add_argument("--longest-edge", type=int, default=768)
    parser.add_argument("--serve", action="store_true")
    return parser.parse_args()


def load_runtime(args: argparse.Namespace):
    checkpoint_dir = args.checkpoint_dir.resolve()
    sys.path.insert(0, str(checkpoint_dir))

    from hf_utils import PairDetr, forward  # noqa: PLC0415

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this smoke test")

    # PairDETR's checkpoint contains the ResNet-50 backbone, so downloading a
    # second pretrained backbone during construction is unnecessary.
    config = DeformableDetrConfig(
        use_timm_backbone=True,
        backbone="resnet50",
        use_pretrained_backbone=False,
    )
    model = PairDetr(DeformableDetrForObjectDetection(config), 1500, 3)

    checkpoint_path = checkpoint_dir / "pytorch_model.bin"
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    incompatible = model.load_state_dict(checkpoint, strict=False)

    processor = AutoImageProcessor.from_pretrained(checkpoint_dir, local_files_only=True)
    processor.size = {
        "shortest_edge": args.shortest_edge,
        "longest_edge": args.longest_edge,
    }
    device = torch.device("cuda:0")
    model.eval().to(device)
    return model, processor, device, incompatible, forward


def infer_image(runtime, image_path: Path, args: argparse.Namespace):
    model, processor, device, incompatible, forward = runtime
    image = Image.open(image_path).convert("RGB")
    inputs = processor(images=image, return_tensors="pt")
    pixel_values = inputs["pixel_values"].to(device)
    torch.cuda.reset_peak_memory_stats(device)
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.float16):
        outputs = forward(model, pixel_values)
    torch.cuda.synchronize(device)

    logits = outputs["logits"]
    boxes = outputs["pred_boxes"]
    probabilities = logits.softmax(-1)
    foreground_scores = probabilities[..., :-1].amax(-1)
    pair_scores = probabilities[0, :, 0]
    body_only_scores = probabilities[0, :, 1]
    paired = pair_scores >= args.pair_threshold
    body_only = body_only_scores >= args.pair_threshold
    # Official PairDETR encoding: class 0 contains [face, body], while class 1
    # is an unpaired body whose face may be hidden or outside the image.
    selected_boxes = torch.cat(
        [boxes[0, paired, 4:8], boxes[0, body_only, 0:4]], dim=0
    )
    selected_faces = torch.cat(
        [boxes[0, paired, 0:4], torch.full_like(boxes[0, body_only, 0:4], float("nan"))],
        dim=0,
    )
    selected_scores = torch.cat(
        [pair_scores[paired], body_only_scores[body_only]], dim=0
    )
    xyxy = torch.empty_like(selected_boxes)
    xyxy[:, 0] = selected_boxes[:, 0] - selected_boxes[:, 2] / 2
    xyxy[:, 1] = selected_boxes[:, 1] - selected_boxes[:, 3] / 2
    xyxy[:, 2] = selected_boxes[:, 0] + selected_boxes[:, 2] / 2
    xyxy[:, 3] = selected_boxes[:, 1] + selected_boxes[:, 3] / 2
    # DETR is already a set predictor. Only collapse near-identical boxes;
    # ordinary 0.5 NMS incorrectly removes heavily overlapping real people.
    keep = nms(xyxy.float(), selected_scores.float(), args.nms_iou)
    xyxy = xyxy[keep]
    selected_faces = selected_faces[keep]
    selected_scores = selected_scores[keep]
    scale = torch.tensor(
        [image.width, image.height, image.width, image.height],
        device=xyxy.device,
    )
    xyxy = (xyxy * scale).clamp_min(0)
    xyxy[:, 0] = xyxy[:, 0].clamp_max(image.width - 1)
    xyxy[:, 2] = xyxy[:, 2].clamp_max(image.width - 1)
    xyxy[:, 1] = xyxy[:, 1].clamp_max(image.height - 1)
    xyxy[:, 3] = xyxy[:, 3].clamp_max(image.height - 1)
    face_xyxy = torch.empty_like(selected_faces)
    face_xyxy[:, 0] = selected_faces[:, 0] - selected_faces[:, 2] / 2
    face_xyxy[:, 1] = selected_faces[:, 1] - selected_faces[:, 3] / 2
    face_xyxy[:, 2] = selected_faces[:, 0] + selected_faces[:, 2] / 2
    face_xyxy[:, 3] = selected_faces[:, 1] + selected_faces[:, 3] / 2
    face_xyxy = face_xyxy * scale
    face_xyxy[:, 0] = face_xyxy[:, 0].clamp(0, image.width - 1)
    face_xyxy[:, 2] = face_xyxy[:, 2].clamp(0, image.width - 1)
    face_xyxy[:, 1] = face_xyxy[:, 1].clamp(0, image.height - 1)
    face_xyxy[:, 3] = face_xyxy[:, 3].clamp(0, image.height - 1)
    prompt_boxes = [
        {
            "box_xyxy": [round(float(value), 2) for value in box],
            "face_box_xyxy": ([round(float(value), 2) for value in face]
                              if bool(torch.isfinite(face).all()) else None),
            "pair_score": round(float(score), 6),
        }
        for box, face, score in zip(xyxy.cpu(), face_xyxy.cpu(), selected_scores.cpu())
    ]
    report = {
        "device": torch.cuda.get_device_name(device),
        "torch": torch.__version__,
        "input_shape": list(pixel_values.shape),
        "logits_shape": list(logits.shape),
        "boxes_shape": list(boxes.shape),
        "finite_logits": bool(torch.isfinite(logits).all().item()),
        "finite_boxes": bool(torch.isfinite(boxes).all().item()),
        "foreground_over_0_50": int((foreground_scores > 0.50).sum().item()),
        "paired_candidates": int(paired.sum().item()),
        "body_only_candidates": int(body_only.sum().item()),
        "body_boxes_after_nms": len(prompt_boxes),
        "top_foreground_scores": [
            round(float(value), 6)
            for value in foreground_scores[0].topk(12).values.cpu()
        ],
        "missing_keys": list(incompatible.missing_keys),
        "unexpected_keys": list(incompatible.unexpected_keys),
        "peak_gpu_mib": round(torch.cuda.max_memory_allocated(device) / 1024**2, 1),
    }
    if report["missing_keys"] or report["unexpected_keys"]:
        raise RuntimeError("Checkpoint did not exactly match the constructed model")
    if not report["finite_logits"] or not report["finite_boxes"]:
        raise RuntimeError("PairDETR produced non-finite outputs")
    return report, {
        "image": str(image_path),
        "image_size": [image.width, image.height],
        "boxes": prompt_boxes,
    }


def write_result(output_path: Path | None, payload):
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(
                payload,
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )



def serve(args: argparse.Namespace, runtime) -> None:
    print(json.dumps({"type": "ready", "device": torch.cuda.get_device_name(runtime[2])}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request.get("payload_b64"):
                request = json.loads(base64.b64decode(request["payload_b64"]).decode("utf-8"))
            if request.get("action") == "shutdown":
                print(json.dumps({"type": "stopped"}), flush=True)
                return
            request_args = argparse.Namespace(**{
                **vars(args),
                "pair_threshold": float(request.get("pair_threshold", args.pair_threshold)),
                "nms_iou": float(request.get("nms_iou", args.nms_iou)),
            })
            image_path = Path(request["image"]).resolve()
            report, payload = infer_image(runtime, image_path, request_args)
            write_result(Path(request["boxes_output"]).resolve(), payload)
            print(json.dumps({"success": True, "report": report}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False), flush=True)


def main() -> None:
    args = parse_args()
    runtime = load_runtime(args)
    if args.serve:
        serve(args, runtime)
        return
    if args.image is None:
        raise ValueError("--image is required unless --serve is used")
    report, payload = infer_image(runtime, args.image.resolve(), args)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    write_result(args.boxes_output, payload)


if __name__ == "__main__":
    main()
