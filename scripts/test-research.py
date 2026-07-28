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
import research as research_module  # noqa: E402
from research import frame_quality_metrics, perceptual_hash  # noqa: E402


def main():
    black_frame = np.zeros((72, 96, 3), dtype=np.uint8)
    noisy_black_frame = np.random.default_rng(7).integers(0, 12, size=(72, 96, 3), dtype=np.uint8)
    checkerboard = (np.indices((72, 96)).sum(axis=0) % 2 * 255).astype(np.uint8)
    sharp_frame = np.repeat(checkerboard[:, :, None], 3, axis=2)
    blurry_frame = research_module.cv2.GaussianBlur(sharp_frame, (0, 0), 4)
    assert frame_quality_metrics(black_frame)["is_black"]
    assert frame_quality_metrics(noisy_black_frame)["is_black"]
    assert not frame_quality_metrics(sharp_frame)["is_black"]
    assert not frame_quality_metrics(sharp_frame)["is_blurry"]
    assert frame_quality_metrics(blurry_frame)["is_blurry"]

    class FakeCapture:
        def __init__(self, frames):
            self.frames = frames
            self.position = 0

        def isOpened(self):
            return True

        def set(self, property_id, value):
            assert property_id == research_module.cv2.CAP_PROP_POS_FRAMES
            self.position = int(value)
            return True

        def read(self):
            if self.position >= len(self.frames):
                return False, None
            frame = self.frames[self.position]
            self.position += 1
            return True, frame.copy()

        def release(self):
            return None

    quality_test_frames = [
        black_frame, blurry_frame, sharp_frame,
        black_frame, noisy_black_frame, black_frame,
        blurry_frame, blurry_frame, blurry_frame,
    ]
    original_open_video = research_module.open_video
    with TemporaryDirectory() as temporary_directory:
        research_module.open_video = lambda _path: FakeCapture(quality_test_frames)
        try:
            selected = research_module.extract_best_frames(
                str(Path(temporary_directory) / "quality-test.mp4"),
                [(0, 2), (3, 5), (6, 8)],
                25.0,
                "quality-test.mp4",
            )
        finally:
            research_module.open_video = original_open_video
        assert len(selected) == 1
        assert selected[0]["selected_frame"] == 2
        assert (Path(temporary_directory) / selected[0]["file"]).is_file()

    with TemporaryDirectory() as temporary_directory:
        selected_video = Path(temporary_directory) / "selected-video.mp4"
        selected_video.write_bytes(b"video placeholder")
        analyzed_paths = []
        original_analyze_video = research_module.analyze_video
        original_deduplication = research_module.process_images_deduplication
        original_move_txt_files = research_module.move_txt_files
        research_module.analyze_video = lambda video_path, _sensitivity, _min_duration: analyzed_paths.append(video_path)
        research_module.process_images_deduplication = lambda _directory: (_ for _ in ()).throw(AssertionError("single-video mode must not deduplicate sibling images"))
        research_module.move_txt_files = lambda _directory: (_ for _ in ()).throw(AssertionError("single-video mode must not move sibling text files"))
        try:
            research_module.run(["--path", str(selected_video), "--sensitivity", "standard", "--min_duration", "0.2"])
        finally:
            research_module.analyze_video = original_analyze_video
            research_module.process_images_deduplication = original_deduplication
            research_module.move_txt_files = original_move_txt_files
        assert analyzed_paths == [str(selected_video)]

    with TemporaryDirectory() as temporary_directory:
        target_directory = Path(temporary_directory)
        (target_directory / "notes.txt").write_text("metadata", encoding="utf-8")
        move_calls = []
        original_deduplication = research_module.process_images_deduplication
        original_move_txt_files = research_module.move_txt_files
        research_module.process_images_deduplication = lambda _directory: None
        research_module.move_txt_files = lambda directory: move_calls.append(directory)
        try:
            research_module.run(["--path", str(target_directory), "--sensitivity", "standard"])
            assert move_calls == [], "folder mode must not organize TXT files unless the panel option is enabled"
            research_module.run(["--path", str(target_directory), "--sensitivity", "standard", "--organize-data"])
        finally:
            research_module.process_images_deduplication = original_deduplication
            research_module.move_txt_files = original_move_txt_files
        assert move_calls == [target_directory], "the data option must forward TXT organization for folder mode"

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
