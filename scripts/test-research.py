"""Regression checks for research-tools algorithms and event compatibility."""

from __future__ import annotations

import json
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from event_protocol import emit  # noqa: E402
from research import perceptual_hash  # noqa: E402


def main():
    expected_hashes = [
        "8ced96f8550e7330",
        "8027cd645f2f5336",
        "ec9214692b63ed63",
        "94cfbe92941f7a08",
        "b74043378eb742f1",
        "932935d646dd5d84",
    ]
    random = np.random.default_rng(20260722)
    actual_hashes = []
    for index in range(len(expected_hashes)):
        pixels = random.integers(0, 256, size=(43 + index, 57 - index, 3), dtype=np.uint8)
        actual_hashes.append(perceptual_hash(Image.fromarray(pixels, "RGB")))
    assert actual_hashes == expected_hashes

    output = StringIO()
    with redirect_stdout(output):
        emit("progress", "working", data={"item": 2}, progress=37)
    assert json.loads(output.getvalue()) == {
        "type": "progress",
        "message": "working",
        "data": {"item": 2},
        "progress": 37,
    }
    print("research-tools regression tests passed")


if __name__ == "__main__":
    main()
