"""Lightweight coordinate helpers shared by advanced inference and tests."""
from __future__ import annotations


def normalized_cxcywh_to_original_xyxy(box, width, height):
    cx, cy, box_width, box_height = (float(value) for value in box)
    x1 = max(0.0, min(float(width - 1), (cx - box_width / 2) * width))
    y1 = max(0.0, min(float(height - 1), (cy - box_height / 2) * height))
    x2 = max(0.0, min(float(width - 1), (cx + box_width / 2) * width))
    y2 = max(0.0, min(float(height - 1), (cy + box_height / 2) * height))
    return [x1, y1, x2, y2]
