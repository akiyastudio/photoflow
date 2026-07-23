"""Regression checks for research-tools algorithms and event compatibility."""

from __future__ import annotations

import json
import subprocess
import sys
from tempfile import TemporaryDirectory
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

    with TemporaryDirectory() as temporary_directory:
        reference_directory = Path(temporary_directory) / "reference"
        source_directory = Path(temporary_directory) / "source"
        reference_directory.mkdir()
        source_directory.mkdir()
        Image.new("RGB", (32, 24), (38, 91, 143)).save(reference_directory / "reference.jpg")
        Image.new("RGB", (32, 24), (38, 91, 143)).save(source_directory / "edited.jpg")

        result = subprocess.run([
            sys.executable,
            str(ROOT / "python" / "rename.py"),
            "--folder_a", str(reference_directory),
            "--folder_b", str(source_directory),
            "--preview",
        ], capture_output=True, text=True, encoding="utf-8", timeout=30, check=False)
        assert result.returncode == 0, result.stderr
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        preview = next(event for event in events if event["type"] == "preview")
        assert preview["data"]["matches"] == [{
            "source": "edited.jpg",
            "reference": "reference.jpg",
            "target": "reference.jpg",
            "confidence": "高",
            "distance": 0,
        }]
        assert any(event["type"] == "success" and event["message"] == "所有任务结束" for event in events)
    print("research-tools regression tests passed")


if __name__ == "__main__":
    main()
