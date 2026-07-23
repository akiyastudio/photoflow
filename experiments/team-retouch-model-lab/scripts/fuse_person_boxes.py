#!/usr/bin/env python3
"""Fuse RTMDet recall with low-threshold PairDETR body associations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan1-report", type=Path, required=True)
    parser.add_argument("--pairdetr-boxes", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--match-iou", type=float, default=0.15)
    parser.add_argument("--extra-threshold", type=float, default=0.50)
    return parser.parse_args()


def iou_matrix(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    top_left = np.maximum(left[:, None, :2], right[None, :, :2])
    bottom_right = np.minimum(left[:, None, 2:], right[None, :, 2:])
    size = np.maximum(0, bottom_right - top_left)
    intersection = size[..., 0] * size[..., 1]
    left_area = np.prod(np.maximum(0, left[:, 2:] - left[:, :2]), axis=1)
    right_area = np.prod(np.maximum(0, right[:, 2:] - right[:, :2]), axis=1)
    union = left_area[:, None] + right_area[None, :] - intersection
    return np.divide(intersection, union, out=np.zeros_like(intersection), where=union > 0)


def main() -> None:
    args = parse_args()
    baseline = json.loads(args.plan1_report.read_text(encoding="utf-8"))
    pair_payload = json.loads(args.pairdetr_boxes.read_text(encoding="utf-8"))
    baseline_items = baseline["person_boxes"]
    pair_items = pair_payload["boxes"]
    baseline_boxes = np.asarray(
        [item["box_xyxy"] for item in baseline_items], dtype=np.float32
    )
    pair_boxes = np.asarray(
        [item["box_xyxy"] for item in pair_items], dtype=np.float32
    )

    matched_baseline: set[int] = set()
    matched_pair: set[int] = set()
    matches: dict[int, tuple[int, float]] = {}
    if len(baseline_boxes) and len(pair_boxes):
        overlaps = iou_matrix(baseline_boxes, pair_boxes)
        order = np.dstack(np.unravel_index(np.argsort(overlaps.ravel())[::-1], overlaps.shape))[0]
        for baseline_index, pair_index in order:
            overlap = float(overlaps[baseline_index, pair_index])
            if overlap < args.match_iou:
                break
            if baseline_index in matched_baseline or pair_index in matched_pair:
                continue
            matched_baseline.add(int(baseline_index))
            matched_pair.add(int(pair_index))
            matches[int(baseline_index)] = (int(pair_index), overlap)

    fused = []
    for baseline_index, baseline_item in enumerate(baseline_items):
        if baseline_index in matches:
            pair_index, overlap = matches[baseline_index]
            pair_item = pair_items[pair_index]
            fused.append(
                {
                    **pair_item,
                    "source": "pairdetr_matched",
                    "rtmdet_score": baseline_item["score"],
                    "match_iou": round(overlap, 6),
                }
            )
        else:
            fused.append(
                {
                    "box_xyxy": baseline_item["box_xyxy"],
                    "pair_score": baseline_item["score"],
                    "source": "rtmdet_fallback",
                    "rtmdet_score": baseline_item["score"],
                    "match_iou": 0.0,
                }
            )

    for pair_index, pair_item in enumerate(pair_items):
        if pair_index in matched_pair:
            continue
        if pair_item["pair_score"] >= args.extra_threshold:
            fused.append({**pair_item, "source": "pairdetr_extra", "match_iou": 0.0})

    output = {
        "image": pair_payload["image"],
        "image_size": pair_payload["image_size"],
        "boxes": fused,
        "diagnostics": {
            "rtmdet_count": len(baseline_items),
            "pairdetr_low_count": len(pair_items),
            "matched_count": len(matches),
            "fused_count": len(fused),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(output["diagnostics"], ensure_ascii=False))


if __name__ == "__main__":
    main()
