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
from rename import build_jpg_proxy_index, find_selection_jpg_proxy_folder, visual_reference_path  # noqa: E402
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

    with TemporaryDirectory() as temporary_directory:
        reference_directory = Path(temporary_directory) / "reference"
        source_directory = Path(temporary_directory) / "source"
        reference_directory.mkdir()
        source_directory.mkdir()
        pixels = np.random.default_rng(42).integers(0, 256, size=(48, 64, 3), dtype=np.uint8)
        Image.fromarray(pixels, "RGB").save(reference_directory / "reference.jpg")
        Image.fromarray(pixels, "RGB").save(source_directory / "new-material.jpg")

        result = subprocess.run([
            sys.executable,
            str(ROOT / "python" / "rename.py"),
            "--folder_a", str(reference_directory),
            "--folder_b", str(source_directory),
            "--threshold", "-1",
            "--preview",
        ], capture_output=True, text=True, encoding="utf-8", timeout=30, check=False)
        assert result.returncode == 0, result.stderr
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        preview = next(event for event in events if event["type"] == "preview")
        assert preview["data"]["matches"] == []
        assert preview["data"]["unmatched"] == ["new-material.jpg"]
        assert preview["data"]["suggestions"] == [{
            "source": "new-material.jpg",
            "reference": "reference.jpg",
            "target": "reference.jpg",
            "confidence": "候选",
            "distance": 0,
        }]

    with TemporaryDirectory() as temporary_directory:
        project_directory = Path(temporary_directory) / "project"
        reference_directory = project_directory / "图片选片"
        jpg_directory = project_directory / "jpg"
        source_directory = project_directory / "图片后期_1"
        reference_directory.mkdir(parents=True)
        jpg_directory.mkdir()
        source_directory.mkdir()
        # The RAW contents are intentionally invalid. The comparison must use
        # the same-stem JPG as a visual proxy while keeping the RAW filename as V0.
        (reference_directory / "IMG_1234.CR3").write_bytes(b"not-a-decodable-raw")
        Image.new("RGB", (32, 24), (38, 91, 143)).save(jpg_directory / "IMG_1234.JPG")
        Image.new("RGB", (32, 24), (38, 91, 143)).save(source_directory / "retouched.jpg")

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
            "source": "retouched.jpg",
            "reference": "IMG_1234.CR3",
            "target": "IMG_1234.jpg",
            "confidence": "高",
            "distance": 0,
        }]
        assert any(
            event["type"] == "log" and "同名 JPG" in event["message"]
            for event in events
        )

        nested_jpg_directory = jpg_directory / "second-card"
        nested_jpg_directory.mkdir()
        Image.new("RGB", (32, 24), (38, 91, 143)).save(nested_jpg_directory / "IMG_1234.jpg")
        proxy_index = build_jpg_proxy_index(str(jpg_directory))
        assert "img_1234" not in proxy_index, "duplicate camera names must not select an unsafe V0 proxy"
        assert find_selection_jpg_proxy_folder(str(reference_directory)) == str(jpg_directory)
        assert find_selection_jpg_proxy_folder(str(source_directory)) is None
        assert visual_reference_path(str(reference_directory / "IMG_1234.CR3"), proxy_index).endswith("IMG_1234.CR3")
    print("research-tools regression tests passed")


if __name__ == "__main__":
    main()
