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


def make_concentrated_phone_artwork() -> np.ndarray:
    """A dark full-width post whose visual detail is concentrated on the right."""
    height, width = 387, 179
    screenshot = np.full((height, width, 3), 250, dtype=np.uint8)
    rng = np.random.default_rng(33)
    artwork = np.full((334, width, 3), (14, 15, 17), dtype=np.uint8)
    texture = rng.normal(0, 5, artwork.shape).astype(np.float32)
    texture = cv2.GaussianBlur(texture, (0, 0), 2)
    artwork = np.clip(artwork.astype(np.float32) + texture, 0, 255).astype(np.uint8)
    artwork[:, 129:, 0] = np.clip(artwork[:, 129:, 0].astype(np.int16) + 3, 0, 255).astype(np.uint8)
    cv2.ellipse(artwork, (55, 92), (39, 58), 0, 190, 530, (145, 125, 130), 7)
    cv2.ellipse(artwork, (55, 92), (31, 49), 0, 185, 535, (7, 8, 10), 10)
    cv2.circle(artwork, (111, 143), 14, (190, 180, 175), -1)
    cv2.rectangle(artwork, (91, 157), (137, 275), (60, 55, 80), -1)
    for y in range(155, 290, 11):
        x = 84 + (y * 3) % 45
        cv2.line(artwork, (x, y), (min(174, x + 35), y + 7), ((y * 5) % 220, 35 + y % 80, 95 + y % 130), 3)
    cv2.line(artwork, (105, 255), (88, 320), (195, 195, 200), 10)
    cv2.line(artwork, (123, 255), (136, 320), (195, 195, 200), 10)
    screenshot[27:361] = artwork
    cv2.putText(screenshot, "prts.wiki", (62, 379), cv2.FONT_HERSHEY_SIMPLEX, 0.25, (110, 110, 110), 1)
    return screenshot


def make_sparse_line_art_screenshot() -> np.ndarray:
    """A white, low-texture sketch panel between solid black app chrome."""
    height, width = 1000, 600
    screenshot = np.full((height, width, 3), 8, dtype=np.uint8)
    screenshot[100:850] = 250
    ink = (205, 175, 190)
    cv2.circle(screenshot, (315, 245), 55, ink, 3)
    cv2.ellipse(screenshot, (305, 460), (75, 190), 10, 0, 360, ink, 4)
    cv2.line(screenshot, (285, 625), (250, 790), ink, 4)
    cv2.line(screenshot, (335, 625), (370, 790), ink, 4)
    return screenshot


def make_white_feed_screenshot() -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """A fixed-source social feed: white chrome, media, then text/actions."""
    height, width = 1800, 900
    screenshot = np.full((height, width, 3), 252, dtype=np.uint8)
    cv2.putText(screenshot, "13:04  5G", (70, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (25, 25, 25), 2)
    cv2.circle(screenshot, (105, 180), 34, (205, 220, 230), -1)
    cv2.putText(screenshot, "creator", (155, 190), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (45, 45, 45), 2)
    expected = (45, 250, 855, 1160)
    screenshot[expected[1]:expected[3], expected[0]:expected[2]] = make_artwork(
        expected[3] - expected[1],
        expected[2] - expected[0],
    )
    for y in range(1235, 1590, 70):
        cv2.rectangle(screenshot, (55, y), (540 + y % 210, y + 10), (55, 55, 55), -1)
    cv2.circle(screenshot, (420, 1685), 24, (220, 30, 75), -1)
    return screenshot, expected


def make_black_viewer_screenshot() -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """A fixed-source immersive viewer with a grayscale image on black chrome."""
    height, width = 1800, 900
    screenshot = np.full((height, width, 3), 5, dtype=np.uint8)
    cv2.line(screenshot, (55, 115), (85, 145), (240, 240, 240), 4)
    cv2.line(screenshot, (85, 115), (55, 145), (240, 240, 240), 4)
    cv2.putText(screenshot, "9/10", (420, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (240, 240, 240), 2)
    expected = (70, 260, 830, 1460)
    artwork = make_artwork(expected[3] - expected[1], expected[2] - expected[0])
    gray = cv2.cvtColor(artwork, cv2.COLOR_BGR2GRAY)
    screenshot[expected[1]:expected[3], expected[0]:expected[2]] = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    cv2.line(screenshot, (330, 1725), (570, 1725), (160, 160, 160), 9)
    return screenshot, expected


def make_story_viewer_screenshot() -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """A full-width story viewer with status chrome and an internal hard edge."""
    height, width = 1200, 600
    screenshot = np.full((height, width, 3), (120, 105, 92), dtype=np.uint8)
    expected = (0, 72, width, 1100)
    artwork = make_artwork(expected[3] - expected[1], width)
    # A strong horizon inside the photograph must not beat the actual bottom
    # edge followed by the dark carousel/control strip.
    artwork[720:726] = (18, 18, 18)
    screenshot[expected[1]:expected[3]] = artwork
    screenshot[expected[3]:] = 8
    cv2.putText(screenshot, "07:31", (45, 46), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (245, 245, 245), 2)
    for x in range(15, width - 15, 62):
        cv2.line(screenshot, (x, 1135), (min(width - 15, x + 46), 1135), (125, 125, 125), 5)
    return screenshot, expected


def assert_rectangle_close(actual: tuple[int, int, int, int] | None, expected: tuple[int, int, int, int], tolerance: int = 3) -> None:
    assert actual is not None and all(abs(actual[index] - expected[index]) <= tolerance for index in range(4)), (actual, expected)


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

    # Subject texture must not be mistaken for the media boundary.  The two
    # strong horizontal transitions identify the complete full-width artwork.
    phone_screenshot = make_concentrated_phone_artwork()
    phone_rectangle, phone_confidence, phone_reason = MODULE.detect_main_rectangle(phone_screenshot)
    assert phone_rectangle == (0, 27, 179, 361), (phone_rectangle, phone_confidence, phone_reason)

    # Strong opposing frame edges must outweigh the sparse sketch's low
    # texture, and its intentional white canvas must not be trimmed away.
    line_art = make_sparse_line_art_screenshot()
    line_art_rectangle, line_art_confidence, line_art_reason = MODULE.detect_main_rectangle(line_art)
    assert line_art_rectangle == (0, 100, 600, 850), (
        line_art_rectangle,
        line_art_confidence,
        line_art_reason,
    )

    white_feed, white_feed_expected = make_white_feed_screenshot()
    white_feed_rectangle, white_feed_confidence, white_feed_reason = MODULE.detect_main_rectangle(white_feed)
    assert_rectangle_close(white_feed_rectangle, white_feed_expected)
    assert not white_feed_reason, (white_feed_rectangle, white_feed_confidence, white_feed_reason)

    black_viewer, black_viewer_expected = make_black_viewer_screenshot()
    black_viewer_rectangle, black_viewer_confidence, black_viewer_reason = MODULE.detect_main_rectangle(black_viewer)
    assert_rectangle_close(black_viewer_rectangle, black_viewer_expected)
    assert not black_viewer_reason, (black_viewer_rectangle, black_viewer_confidence, black_viewer_reason)

    story_viewer, story_viewer_expected = make_story_viewer_screenshot()
    story_viewer_rectangle, story_viewer_confidence, story_viewer_reason = MODULE.detect_main_rectangle(story_viewer)
    assert_rectangle_close(story_viewer_rectangle, story_viewer_expected)
    assert not story_viewer_reason, (story_viewer_rectangle, story_viewer_confidence, story_viewer_reason)

    # A weak boundary on only one side is not enough evidence to delete the
    # opposite, low-texture portion of an image.
    weak_rows = np.full(99, 8.0, dtype=np.float32)
    weak_columns = np.full(99, 8.0, dtype=np.float32)
    weak_columns[39] = 1.0
    expanded = MODULE._expand_weak_single_sided_crops(
        (40, 10, 100, 90),
        (weak_rows, weak_columns),
        100,
        100,
    )
    assert expanded == (0, 10, 100, 90), expanded

    note = np.full((1600, 900, 3), 250, dtype=np.uint8)
    for y in range(160, 1400, 50):
        cv2.rectangle(note, (80, y), (520 + y % 240, y + 5), (42, 42, 42), -1)
    note_path = directory / "note.png"
    cv2.imwrite(str(note_path), note)
    note_result = MODULE.extract_main_image(str(note_path))
    assert note_result["success"] and note_result["skipped"] and not note_result["cropped"], note_result

    note_analysis = MODULE.analyze_main_image(str(note_path))
    assert note_analysis["success"] and note_analysis["crop"] and note_analysis["needsReview"], note_analysis
    assert note_analysis["snapGuides"]["x"] and note_analysis["snapGuides"]["y"], note_analysis

    manual_result = MODULE.crop_main_image(str(note_path), "40,60,720,1080")
    assert manual_result["success"] and manual_result["cropped"], manual_result
    assert manual_result["outputSize"] == {"width": 720, "height": 1080}, manual_result
    assert Path(manual_result["output"]).exists(), manual_result

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
