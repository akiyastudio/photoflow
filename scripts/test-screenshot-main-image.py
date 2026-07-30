import importlib.util
import io
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
import json

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "python" / "screenshot_main_image.py"
SPEC = importlib.util.spec_from_file_location("screenshot_main_image", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def make_artwork(height: int, width: int) -> np.ndarray:
    rng = np.random.default_rng(20260729)
    artwork = rng.integers(0, 256, (height, width, 3), dtype=np.uint8)
    artwork = cv2.GaussianBlur(artwork, (0, 0), 3)
    cv2.circle(artwork, (width // 2, height // 2), min(height, width) // 4, (15, 90, 235), -1)
    cv2.rectangle(artwork, (width // 8, height // 9), (width * 7 // 8, height * 8 // 9), (210, 80, 35), 10)
    return artwork


with tempfile.TemporaryDirectory(prefix="photoflow-screenshot-main-") as temporary:
    directory = Path(temporary)

    screenshot = np.full((1920, 1080, 3), 18, dtype=np.uint8)
    for y in range(55, 245, 36):
        cv2.rectangle(screenshot, (80, y), (600 + y % 170, y + 8), (205, 205, 205), -1)
    expected = (90, 310, 990, 1310)
    screenshot[expected[1]:expected[3], expected[0]:expected[2]] = make_artwork(1000, 900)
    for y in range(1390, 1780, 44):
        cv2.rectangle(screenshot, (80, y), (850 - y % 230, y + 7), (170, 170, 170), -1)
    screenshot_path = directory / "social.png"
    cv2.imwrite(str(screenshot_path), screenshot)

    result = MODULE.extract_main_image(str(screenshot_path))
    assert result["success"] and result["cropped"], result
    crop = result["crop"]
    assert abs(crop["x"] - expected[0]) <= 90, crop
    assert abs(crop["y"] - expected[1]) <= 120, crop
    assert abs(crop["width"] - (expected[2] - expected[0])) <= 150, crop
    assert abs(crop["height"] - (expected[3] - expected[1])) <= 180, crop
    assert Path(result["output"]).exists(), result
    assert screenshot_path.exists(), "original input must never be overwritten"

    note = np.full((1600, 900, 3), 250, dtype=np.uint8)
    for y in range(160, 1400, 50):
        cv2.rectangle(note, (80, y), (520 + y % 240, y + 5), (42, 42, 42), -1)
    note_path = directory / "note.png"
    cv2.imwrite(str(note_path), note)
    note_result = MODULE.extract_main_image(str(note_path))
    assert note_result["success"] and note_result["skipped"] and not note_result["cropped"], note_result

    second_result = MODULE.extract_main_image(str(screenshot_path))
    assert second_result["success"] and second_result["cropped"], second_result
    assert second_result["output"] != result["output"], "batch reruns must not overwrite previous output"

    chinese_path = directory / "策划截图.jpg"
    chinese_path.write_bytes(screenshot_path.read_bytes())
    protocol_output = io.StringIO()
    with redirect_stdout(protocol_output):
        MODULE.run(["extract", "--input", str(chinese_path)])
    protocol_lines = [line for line in protocol_output.getvalue().splitlines() if line.strip()]
    assert protocol_lines and all(line.isascii() for line in protocol_lines), "JSON pipe output must stay ASCII-safe on Windows code pages"
    protocol_events = [json.loads(line) for line in protocol_lines]
    progress_events = [event for event in protocol_events if event.get("type") == "progress"]
    assert [event.get("phase") for event in progress_events] == ["item-start", "item-complete"], progress_events
    assert progress_events[-1]["progress"] == 100, progress_events
    assert protocol_events[-1]["results"][0]["inputName"] == chinese_path.name, protocol_events[-1]

print("screenshot main image tests passed")
