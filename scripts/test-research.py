"""Regression checks for the built-in research worker and event compatibility."""

from __future__ import annotations

import json
import os
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

from event_protocol import emit, log_warning  # noqa: E402
import rename as rename_module  # noqa: E402
from rename import build_jpg_proxy_index, find_selection_jpg_proxy_folder, unique_stem_index, visual_reference_path  # noqa: E402
import research as research_module  # noqa: E402
from research import detected_video_container, frame_quality_metrics, perceptual_hash  # noqa: E402


class ReconfigurableStringIO(StringIO):
    def reconfigure(self, **_kwargs):
        return None


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

    # Screenshot publication must never overwrite an output from an earlier run,
    # and the capture must be released even when publication is refused.
    with TemporaryDirectory() as temporary_directory:
        target = Path(temporary_directory) / "quality-test_001_0.080s.jpg"
        target.write_bytes(b"pre-existing")
        capture = FakeCapture(quality_test_frames[:3])
        capture.released = False
        capture.release = lambda: setattr(capture, "released", True)
        research_module.open_video = lambda _path: capture
        try:
            selected = research_module.extract_best_frames(
                str(Path(temporary_directory) / "quality-test.mp4"), [(0, 2)], 25.0, "quality-test.mp4"
            )
        finally:
            research_module.open_video = original_open_video
        assert target.read_bytes() == b"pre-existing"
        assert selected == []
        assert capture.released

    # pHash is only a candidate lookup: flat but visibly different images share
    # a pHash and must survive the strong content check.  Recycle failures must
    # be reflected in the returned counts.
    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        existing = root / "existing.jpg"
        generated_collision = root / "generated-collision.jpg"
        generated_a = root / "generated-a.jpg"
        generated_b = root / "generated-b.jpg"
        Image.new("RGB", (32, 32), (255, 0, 0)).save(existing)
        generated_collision.write_bytes(existing.read_bytes())
        Image.new("RGB", (32, 32), (0, 0, 255)).save(generated_a)
        generated_b.write_bytes(generated_a.read_bytes())
        original_send2trash = research_module.send2trash
        research_module.send2trash = lambda _path: (_ for _ in ()).throw(OSError("recycle unavailable"))
        try:
            result = research_module.process_images_deduplication([generated_collision, generated_a, generated_b])
        finally:
            research_module.send2trash = original_send2trash
        assert existing.exists(), "pre-existing sibling images must never enter the deduplication set"
        assert result == {"duplicateCount": 1, "recycledCount": 0, "failedCount": 1}

    class InvalidFpsCapture:
        released = False
        def __init__(self):
            self.frames = [sharp_frame, sharp_frame]
        def isOpened(self):
            return True
        def get(self, _property_id):
            return float("nan")
        def read(self):
            if not self.frames:
                return False, None
            return True, self.frames.pop(0).copy()
        def release(self):
            self.released = True
    invalid_capture = InvalidFpsCapture()
    fallback_fps = []
    original_extract = research_module.extract_best_frames
    research_module.open_video = lambda _path: invalid_capture
    research_module.extract_best_frames = lambda _path, _shots, fps, _name: fallback_fps.append(fps) or []
    try:
        assert research_module.analyze_video("invalid-fps.mp4", "standard", 0.2) == []
    finally:
        research_module.open_video = original_open_video
        research_module.extract_best_frames = original_extract
    assert invalid_capture.released
    assert fallback_fps == [25.0]

    # Organizing TXT files uses no-replace publication as well.
    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        (root / "note.txt").write_text("new", encoding="utf-8")
        (root / "data").mkdir()
        (root / "data" / "note.txt").write_text("old", encoding="utf-8")
        result = research_module.move_txt_files(root)
        assert (root / "note.txt").read_text(encoding="utf-8") == "new"
        assert (root / "data" / "note.txt").read_text(encoding="utf-8") == "old"
        assert result["failedCount"] == 1

    # A filesystem without hard-link support must still publish safely through
    # the documented no-overwrite fallback.
    with TemporaryDirectory() as temporary_directory:
        target = Path(temporary_directory) / "fallback.jpg"
        fallback_source = Path(temporary_directory) / "fallback-source.jpg"
        Image.new("RGB", (32, 32), (0, 0, 255)).save(fallback_source)
        original_link = research_module.os.link
        original_native = research_module.try_atomic_rename_no_replace
        research_module.os.link = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("hard links unavailable"))
        research_module.try_atomic_rename_no_replace = lambda _source, _destination: False
        try:
            publication = research_module.atomic_publish_bytes_no_replace(
                target, fallback_source.read_bytes(), research_module.validate_jpeg
            )
        finally:
            research_module.os.link = original_link
            research_module.try_atomic_rename_no_replace = original_native
        assert target.is_file() and publication == "safe-fallback"

    # Once fallback has claimed the formal target, a copy failure plus repeated
    # cleanup failure must preserve the complete staging file and recovery marker.
    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        target = root / "interrupted.jpg"
        source_image = root / "source.jpg"
        Image.new("RGB", (48, 32), (12, 34, 56)).save(source_image)
        payload = source_image.read_bytes()
        original_native = research_module.try_atomic_rename_no_replace
        original_copyfileobj = research_module.shutil.copyfileobj
        original_unlink = research_module.os.unlink
        marker_seen_during_copy = False
        def fail_mid_copy(input_file, output_file, _length):
            nonlocal marker_seen_during_copy
            marker_seen_during_copy = bool(list(root.glob(".interrupted.jpg.photoflow-recovery-*.json")))
            output_file.write(input_file.read(17))
            output_file.flush()
            raise OSError("injected mid-copy failure")
        def refuse_partial_cleanup(path):
            if Path(path) == target:
                raise OSError("injected persistent cleanup failure")
            return original_unlink(path)
        research_module.try_atomic_rename_no_replace = lambda _source, _destination: False
        research_module.shutil.copyfileobj = fail_mid_copy
        research_module.os.unlink = refuse_partial_cleanup
        try:
            try:
                research_module.atomic_publish_bytes_no_replace(target, payload, research_module.validate_jpeg)
                raise AssertionError("expected uncommitted publication")
            except research_module.PublishCleanupError as error:
                staging = Path(error.source)
                marker = Path(error.recovery_marker)
                assert staging.read_bytes() == payload
                assert target.read_bytes() == payload[:17]
                assert marker.is_file()
                assert marker_seen_during_copy, "recovery ownership must be durable before fallback copy starts"
        finally:
            research_module.try_atomic_rename_no_replace = original_native
            research_module.shutil.copyfileobj = original_copyfileobj
            research_module.os.unlink = original_unlink
        recovered_staging = Path(research_module.recover_incomplete_publication(marker, root, root))
        assert recovered_staging == target and recovered_staging.read_bytes() == payload
        assert not marker.exists()
        recovered_staging.unlink()

    # Simulate process termination after O_EXCL claim: only the durable
    # "copying" marker and a short formal target remain for the next process.
    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        staging = root / ".hard-exit-output.photoflow-staging.part"
        partial = root / "hard-exit-output.jpg"
        staging.write_bytes(b"complete-staging-after-hard-exit")
        with open(partial, "xb") as claimed:
            marker = Path(research_module.write_recovery_marker(staging, partial, state="copying"))
            claimed.write(b"short")
            claimed.flush()
            os.fsync(claimed.fileno())
        assert json.loads(marker.read_text(encoding="utf-8"))["state"] == "copying"
        recovered = Path(research_module.recover_incomplete_publication(marker, root, root))
        assert recovered == partial and partial.read_bytes() == b"complete-staging-after-hard-exit"
        assert not marker.exists()

    # Real process termination at reservation and mid-copy boundaries. A normal
    # subsequent CLI run must discover and recover both without test-only calls.
    crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import research
root = Path(sys.argv[2])
mode = sys.argv[3]
payload = (root / "payload.jpg").read_bytes()
target = root / f"{mode}.jpg"
research.try_atomic_rename_no_replace = lambda _source, _destination: False
if mode == "reservation-crash":
    original = research.write_recovery_marker
    def crash_after_marker(*args, **kwargs):
        marker = original(*args, **kwargs)
        os._exit(71)
    research.write_recovery_marker = crash_after_marker
else:
    def crash_mid_copy(input_file, output_file, _length):
        output_file.write(input_file.read(13))
        output_file.flush()
        os._exit(72)
    research.shutil.copyfileobj = crash_mid_copy
research.atomic_publish_bytes_no_replace(target, payload, research.validate_jpeg)
'''
    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        Image.new("RGB", (40, 30), (65, 43, 21)).save(root / "payload.jpg")
        payload = (root / "payload.jpg").read_bytes()
        for mode, exit_code in (("reservation-crash", 71), ("mid-copy-crash", 72)):
            crashed = subprocess.run(
                [sys.executable, "-c", crash_script, str(ROOT), str(root), mode],
                cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
            )
            assert crashed.returncode == exit_code
            markers = list(root.glob(f".{mode}.jpg.photoflow-recovery-*.json"))
            assert len(markers) == 1
            if mode == "reservation-crash":
                assert not (root / f"{mode}.jpg").exists()
            else:
                assert (root / f"{mode}.jpg").read_bytes() == payload[:13]
            resumed = subprocess.run(
                [sys.executable, str(ROOT / "python" / "research.py"), "--path", str(root)],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30, check=False,
            )
            assert resumed.returncode == 0, resumed.stderr
            resumed_events = [json.loads(line) for line in resumed.stdout.splitlines() if line.strip()]
            assert any(event["type"] == "success" for event in resumed_events)
            assert (root / f"{mode}.jpg").read_bytes() == payload
            assert not list(root.glob(f".{mode}.jpg.photoflow-recovery-*.json"))

    with TemporaryDirectory() as temporary_directory:
        selected_video = Path(temporary_directory) / "selected-video.mp4"
        selected_video.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")
        analyzed_paths = []
        original_analyze_video = research_module.analyze_video
        original_deduplication = research_module.process_images_deduplication
        original_move_txt_files = research_module.move_txt_files
        research_module.analyze_video = lambda video_path, _sensitivity, _min_duration: analyzed_paths.append(video_path) or []
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
        root_directory = Path(temporary_directory)
        nested_directory = root_directory / "nested"
        nested_directory.mkdir()
        first_video = root_directory / "first.mp4"
        second_video = nested_directory / "second.mov"
        video_header = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"
        first_video.write_bytes(video_header)
        second_video.write_bytes(video_header)
        analyzed_paths = []
        cleanup_paths = []
        original_analyze_video = research_module.analyze_video
        original_deduplication = research_module.process_images_deduplication
        research_module.analyze_video = lambda video_path, _sensitivity, _min_duration: analyzed_paths.append(video_path) or []
        research_module.process_images_deduplication = lambda directory: cleanup_paths.append(directory)
        try:
            research_module.run([
                "--path", str(root_directory),
                "--path", str(second_video),
                "--sensitivity", "standard",
            ])
        finally:
            research_module.analyze_video = original_analyze_video
            research_module.process_images_deduplication = original_deduplication
        assert analyzed_paths == [str(first_video), str(second_video)], "folders must be recursive and overlapping inputs must be de-duplicated"
        assert cleanup_paths == [], "videos producing no screenshots must not trigger image cleanup"

    with TemporaryDirectory() as temporary_directory:
        target_directory = Path(temporary_directory)
        valid_video = target_directory / "valid.mp4"
        fake_javascript = target_directory / "script.mp4"
        fake_webp = target_directory / "image.mp4"
        valid_video.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")
        fake_javascript.write_bytes(b"/*! html2canvas */")
        fake_webp.write_bytes(b"RIFF\x0c\x00\x00\x00WEBPVP8 ")
        assert detected_video_container(valid_video) == "iso-bmff"
        assert detected_video_container(fake_javascript) is None
        assert detected_video_container(fake_webp) is None

        analyzed_paths = []
        warnings = []
        original_analyze_video = research_module.analyze_video
        original_deduplication = research_module.process_images_deduplication
        original_log_warning = research_module.log_warning
        research_module.analyze_video = lambda video_path, _sensitivity, _min_duration: analyzed_paths.append(video_path) or []
        research_module.process_images_deduplication = lambda _directory: None
        research_module.log_warning = lambda message, data=None: warnings.append((message, data))
        try:
            research_module.run(["--path", str(target_directory), "--sensitivity", "standard"])
        finally:
            research_module.analyze_video = original_analyze_video
            research_module.process_images_deduplication = original_deduplication
            research_module.log_warning = original_log_warning
        assert analyzed_paths == [str(valid_video)]
        assert len(warnings) == 1
        assert warnings[0][1] == {"skippedCount": 2, "processedCount": 1}

        output = StringIO()
        with redirect_stdout(output):
            research_module.run(["--path", str(target_directory), "--sensitivity", "standard"])
        terminal_events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]
        assert terminal_events[-1]["type"] == "error"
        assert not any(event["type"] in {"partial", "success"} for event in terminal_events)

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

    # Batch rename publication is transactional: a failure after one final name
    # is published must restore every original source name.
    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        originals = [folder / "one.jpg", folder / "two.jpg"]
        for path in originals:
            path.write_bytes(path.name.encode("ascii"))
        moves = [(str(originals[0]), str(folder / "A.jpg")), (str(originals[1]), str(folder / "B.jpg"))]
        original_atomic_move = rename_module.atomic_move_no_replace
        publish_count = 0
        def fail_second_publish(source, destination):
            nonlocal publish_count
            if ".photoflow-rename-" not in Path(destination).name:
                publish_count += 1
                if publish_count == 2:
                    raise OSError("injected publish failure")
            return original_atomic_move(source, destination)
        rename_module.atomic_move_no_replace = fail_second_publish
        try:
            try:
                rename_module.execute_two_phase_moves(moves)
                raise AssertionError("expected injected rename failure")
            except rename_module.MoveTransactionError as error:
                assert not error.rollback_errors
        finally:
            rename_module.atomic_move_no_replace = original_atomic_move
        assert [path.read_bytes() for path in originals] == [b"one.jpg", b"two.jpg"]
        assert not (folder / "A.jpg").exists() and not (folder / "B.jpg").exists()

    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        source = folder / "case-only.jpg"
        destination = folder / "CASE-ONLY.jpg"
        source.write_bytes(b"case-only")
        original_link = rename_module.os.link
        rename_module.os.link = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("hard links unavailable"))
        try:
            rename_module.execute_two_phase_moves([(str(source), str(destination))])
        finally:
            rename_module.os.link = original_link
        assert destination.read_bytes() == b"case-only"

    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        source = folder / "no-links.jpg"
        destination = folder / "no-links-renamed.jpg"
        source.write_bytes(b"no-hard-links")
        original_native = rename_module.try_atomic_rename_no_replace
        original_link = rename_module.os.link
        rename_module.try_atomic_rename_no_replace = lambda _source, _destination: False
        rename_module.os.link = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("hard links unavailable"))
        try:
            rename_module.execute_two_phase_moves([(str(source), str(destination))])
        finally:
            rename_module.try_atomic_rename_no_replace = original_native
            rename_module.os.link = original_link
        assert destination.read_bytes() == b"no-hard-links"

    # If fallback publication creates the staged target but cannot remove the
    # source, the transaction must track that intermediate state and clean it.
    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        source = folder / "cleanup-failure.jpg"
        source.write_bytes(b"cleanup-failure")
        destination = folder / "renamed.jpg"
        original_native = rename_module.try_atomic_rename_no_replace
        original_unlink = rename_module.os.unlink
        unlink_calls = 0
        def fail_initial_cleanup(path):
            nonlocal unlink_calls
            unlink_calls += 1
            if unlink_calls <= 2:
                raise OSError("injected cleanup failure")
            return original_unlink(path)
        rename_module.try_atomic_rename_no_replace = lambda _source, _destination: False
        rename_module.os.unlink = fail_initial_cleanup
        try:
            try:
                rename_module.execute_two_phase_moves([(str(source), str(destination))])
                raise AssertionError("expected cleanup failure")
            except rename_module.MoveTransactionError as error:
                assert not error.rollback_errors
        finally:
            rename_module.try_atomic_rename_no_replace = original_native
            rename_module.os.unlink = original_unlink
        assert source.read_bytes() == b"cleanup-failure"
        assert not destination.exists()
        assert not list(folder.glob("*.photoflow-rename-*.part"))

    # A cleanup that also fails during rollback must be reported instead of
    # being mislabeled as a complete rollback.
    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        source = folder / "persistent-cleanup.jpg"
        source.write_bytes(b"persistent-cleanup")
        destination = folder / "renamed.jpg"
        original_native = rename_module.try_atomic_rename_no_replace
        original_unlink = rename_module.os.unlink
        def fail_hidden_cleanup(path):
            if ".photoflow-rename-" in Path(path).name:
                raise OSError("persistent cleanup failure")
            if Path(path) == source:
                raise OSError("source cleanup failure")
            return original_unlink(path)
        rename_module.try_atomic_rename_no_replace = lambda _source, _destination: False
        rename_module.os.unlink = fail_hidden_cleanup
        try:
            try:
                rename_module.execute_two_phase_moves([(str(source), str(destination))])
                raise AssertionError("expected persistent cleanup failure")
            except rename_module.MoveTransactionError as error:
                assert len(error.rollback_errors) == 1
        finally:
            rename_module.try_atomic_rename_no_replace = original_native
            rename_module.os.unlink = original_unlink
        for leftover in folder.glob("*.photoflow-rename-*.part"):
            leftover.unlink()

    # Simulate a crash-recoverable phase-two copy failure. The formal partial
    # and full staging must both be reported, and rollback failure must be nonzero.
    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        source = folder / "phase-two-source.jpg"
        destination = folder / "phase-two-target.jpg"
        source.write_bytes(b"complete-phase-two-source")
        original_native = rename_module.try_atomic_rename_no_replace
        original_copyfileobj = rename_module.shutil.copyfileobj
        original_unlink = rename_module.os.unlink
        marker_seen_during_copy = False
        def stage_then_fallback(src, dst):
            if ".photoflow-rename-" in Path(dst).name:
                os.rename(src, dst)
                return True
            return False
        def fail_phase_two_copy(input_file, output_file, _length):
            nonlocal marker_seen_during_copy
            marker_seen_during_copy = bool(list(folder.glob(".phase-two-target.jpg.photoflow-recovery-*.json")))
            output_file.write(input_file.read(7))
            output_file.flush()
            raise OSError("phase-two copy interrupted")
        def refuse_formal_cleanup(path):
            if Path(path) == destination:
                raise OSError("formal target cleanup unavailable")
            return original_unlink(path)
        rename_module.try_atomic_rename_no_replace = stage_then_fallback
        rename_module.shutil.copyfileobj = fail_phase_two_copy
        rename_module.os.unlink = refuse_formal_cleanup
        try:
            try:
                rename_module.execute_two_phase_moves([(str(source), str(destination))])
                raise AssertionError("expected phase-two transaction failure")
            except rename_module.MoveTransactionError as error:
                assert len(error.rollback_errors) == 1
                assert isinstance(error.cause, rename_module.PublishCleanupError)
                marker = Path(error.cause.recovery_marker)
                staging = Path(error.cause.source)
                assert staging.read_bytes() == b"complete-phase-two-source"
                assert destination.read_bytes() == b"complet"
                assert marker.is_file()
                assert marker_seen_during_copy
        finally:
            rename_module.try_atomic_rename_no_replace = original_native
            rename_module.shutil.copyfileobj = original_copyfileobj
            rename_module.os.unlink = original_unlink
        recovered = Path(rename_module.recover_incomplete_publication(marker, folder, folder))
        assert recovered == destination and destination.read_bytes() == b"complete-phase-two-source"
        assert not marker.exists()

    # The transaction entry itself must recover a real phase-two hard exit before
    # starting the retry, then complete the requested rename normally.
    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        source = folder / "subprocess-rename-source.jpg"
        destination = folder / "subprocess-rename-target.jpg"
        source.write_bytes(b"complete-subprocess-rename-source")
        crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import rename
source, destination = sys.argv[2], sys.argv[3]
def stage_then_fallback(src, dst):
    if ".photoflow-rename-" in Path(dst).name:
        os.rename(src, dst)
        return True
    return False
def crash_mid_copy(input_file, output_file, _length):
    output_file.write(input_file.read(8))
    output_file.flush()
    os._exit(74)
rename.try_atomic_rename_no_replace = stage_then_fallback
rename.shutil.copyfileobj = crash_mid_copy
rename.execute_two_phase_moves([(source, destination)])
'''
        crashed = subprocess.run(
            [sys.executable, "-c", crash_script, str(ROOT), str(source), str(destination)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert crashed.returncode == 74
        assert destination.read_bytes() == b"complete"
        assert list(folder.glob(f".{destination.name}.photoflow-recovery-*.json"))
        resumed_script = r'''
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import rename
rename.execute_two_phase_moves([(sys.argv[2], sys.argv[3])])
'''
        resumed = subprocess.run(
            [sys.executable, "-c", resumed_script, str(ROOT), str(source), str(destination)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert resumed.returncode == 0, resumed.stderr
        assert destination.read_bytes() == b"complete-subprocess-rename-source"
        assert not source.exists()
        assert not list(folder.glob(".*.photoflow-recovery-*.json"))
        assert not list(folder.glob("*.photoflow-rename-*.part"))

    # Real TXT mid-copy exit: the next normal research CLI run must scan data/
    # before organizing and leave exactly one complete destination.
    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        note = root / "note.txt"
        note.write_bytes(b"complete-txt-content")
        crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import research
research.try_atomic_rename_no_replace = lambda _source, _destination: False
def crash_mid_copy(input_file, output_file, _length):
    output_file.write(input_file.read(5)); output_file.flush(); os._exit(75)
research.shutil.copyfileobj = crash_mid_copy
research.move_txt_files(sys.argv[2])
'''
        crashed = subprocess.run(
            [sys.executable, "-c", crash_script, str(ROOT), str(root)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert crashed.returncode == 75
        resumed = subprocess.run(
            [sys.executable, str(ROOT / "python" / "research.py"), "--path", str(root), "--organize-data"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30, check=False,
        )
        assert resumed.returncode == 0, resumed.stderr
        assert (root / "data" / "note.txt").read_bytes() == b"complete-txt-content"
        assert not note.exists()
        assert not list((root / "data").glob(".*.photoflow-recovery-*.json"))
        assert not list((root / "data").glob("*.photoflow-*.part"))

    # Real unmatched-reference copy exit: normal rename CLI recovery must reuse
    # the recovered name rather than creating reference_1.jpg.
    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        folder_a, folder_b = root / "a", root / "b"
        folder_a.mkdir(); folder_b.mkdir()
        Image.new("RGB", (24, 18), (10, 20, 30)).save(folder_a / "reference.jpg")
        Image.new("RGB", (24, 18), (200, 180, 160)).save(folder_b / "other.jpg")
        crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import rename
rename.try_atomic_rename_no_replace = lambda _source, _destination: False
def crash_mid_copy(input_file, output_file, _length):
    output_file.write(input_file.read(11)); output_file.flush(); os._exit(76)
rename.shutil.copyfileobj = crash_mid_copy
rename.copy_unmatched_a_files(["reference.jpg"], sys.argv[2])
'''
        crashed = subprocess.run(
            [sys.executable, "-c", crash_script, str(ROOT), str(folder_a)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert crashed.returncode == 76
        resumed = subprocess.run([
            sys.executable, str(ROOT / "python" / "rename.py"),
            "--folder_a", str(folder_a), "--folder_b", str(folder_b),
            "--threshold", "-1", "--copy_unmatched",
        ], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30, check=False)
        assert resumed.returncode == 0, resumed.stderr
        unmatched = folder_a / "未匹配的图片_A"
        assert (unmatched / "reference.jpg").read_bytes() == (folder_a / "reference.jpg").read_bytes()
        assert not (unmatched / "reference_1.jpg").exists()
        assert not list(unmatched.glob(".*.photoflow-recovery-*.json"))
        assert not list(unmatched.glob("*.photoflow-*.part"))

    # Research committing window: exit immediately after deleting the original
    # TXT source. The next normal CLI must trust the fsynced final digest.
    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        note = root / "commit-note.txt"
        note.write_bytes(b"research-committing-window")
        crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import research
research.try_atomic_rename_no_replace = lambda _source, _destination: False
original_unlink = research.os.unlink
source = os.path.abspath(sys.argv[2])
def crash_after_source_cleanup(path):
    original_unlink(path)
    if os.path.abspath(path) == source:
        os._exit(78)
research.os.unlink = crash_after_source_cleanup
research.move_txt_files(str(Path(source).parent))
'''
        crashed = subprocess.run(
            [sys.executable, "-c", crash_script, str(ROOT), str(note)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert crashed.returncode == 78
        resumed = subprocess.run(
            [sys.executable, str(ROOT / "python" / "research.py"), "--path", str(root), "--organize-data"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30, check=False,
        )
        assert resumed.returncode == 0, resumed.stderr
        assert (root / "data" / note.name).read_bytes() == b"research-committing-window"
        assert not list((root / "data").glob(".*.photoflow-recovery-*.json"))
        assert not list((root / "data").glob("*.photoflow-*.part"))

    # Rename committing window plus the earlier staging-preparing window.
    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        source = folder / "commit-source.jpg"
        destination = folder / "commit-target.jpg"
        source.write_bytes(b"rename-committing-window")
        crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import rename
source, destination = sys.argv[2], sys.argv[3]
def stage_then_fallback(src, dst):
    if ".photoflow-rename-" in Path(dst).name:
        os.rename(src, dst); return True
    return False
rename.try_atomic_rename_no_replace = stage_then_fallback
original_unlink = rename.os.unlink
def crash_after_transaction_temp(path):
    original_unlink(path)
    if ".photoflow-rename-" in Path(path).name:
        os._exit(79)
rename.os.unlink = crash_after_transaction_temp
rename.execute_two_phase_moves([(source, destination)])
'''
        crashed = subprocess.run(
            [sys.executable, "-c", crash_script, str(ROOT), str(source), str(destination)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert crashed.returncode == 79
        resumed = subprocess.run(
            [sys.executable, "-c", resumed_script, str(ROOT), str(source), str(destination)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert resumed.returncode == 0, resumed.stderr
        assert destination.read_bytes() == b"rename-committing-window"
        assert not list(folder.glob(".*.photoflow-recovery-*.json"))
        assert not list(folder.glob("*.photoflow-*.part"))

    # Marker initial publication and the former preparation-field update entry
    # are both hard-exit safe: no malformed final marker can permanently block.
    for mode, exit_code in (("initial-marker", 81), ("ownership-update", 82)):
        with TemporaryDirectory() as temporary_directory:
            folder = Path(temporary_directory)
            source = folder / f"{mode}-source.jpg"
            destination = folder / f"{mode}-target.jpg"
            source.write_bytes(f"{mode}-complete".encode("ascii"))
            crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import rename
mode, source, destination = sys.argv[2], sys.argv[3], sys.argv[4]
rename.try_atomic_rename_no_replace = lambda _source, _destination: False
if mode == "initial-marker":
    original_rename = rename.os.rename
    def crash_before_marker_publish(src, dst):
        if str(dst).endswith(".json"):
            os._exit(81)
        return original_rename(src, dst)
    rename.os.rename = crash_before_marker_publish
else:
    def crash_at_old_update_entry(_marker, **_updates):
        os._exit(82)
    rename.update_recovery_marker = crash_at_old_update_entry
rename.execute_two_phase_moves([(source, destination)])
'''
            crashed = subprocess.run(
                [sys.executable, "-c", crash_script, str(ROOT), mode, str(source), str(destination)],
                cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
            )
            assert crashed.returncode == exit_code
            published_markers = list(folder.glob(".*.photoflow-recovery-*.json"))
            if mode == "initial-marker":
                assert published_markers == [], "initial marker must not become visible before atomic publication"
            else:
                assert len(published_markers) == 1
                marker_payload = json.loads(published_markers[0].read_text(encoding="utf-8"))
                assert marker_payload["state"] == "staging-preparing"
                assert marker_payload["preparationSourcePath"] == str(source.resolve())
                assert marker_payload["preparationSourceIdentity"]
                assert marker_payload["preparationSourceSize"] == source.stat().st_size
                assert marker_payload["preparationSourceDigest"]
                assert marker_payload["partialPath"] == marker_payload["recoveryPath"]
                assert Path(marker_payload["partialPath"]).parent == folder
            resumed = subprocess.run(
                [sys.executable, "-c", resumed_script, str(ROOT), str(source), str(destination)],
                cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
            )
            assert resumed.returncode == 0, resumed.stderr
            assert destination.read_bytes() == f"{mode}-complete".encode("ascii")
            assert not list(folder.glob(".*.photoflow-recovery-*.json"))

    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        source = folder / "prepare-source.jpg"
        destination = folder / "prepare-target.jpg"
        source.write_bytes(b"rename-staging-preparing-window")
        crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import rename
rename.try_atomic_rename_no_replace = lambda _source, _destination: False
def crash_preparing(input_file, output_file, _length):
    output_file.write(input_file.read(10)); output_file.flush(); os._exit(80)
rename.shutil.copyfileobj = crash_preparing
rename.execute_two_phase_moves([(sys.argv[2], sys.argv[3])])
'''
        crashed = subprocess.run(
            [sys.executable, "-c", crash_script, str(ROOT), str(source), str(destination)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert crashed.returncode == 80
        resumed = subprocess.run(
            [sys.executable, "-c", resumed_script, str(ROOT), str(source), str(destination)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert resumed.returncode == 0, resumed.stderr
        assert destination.read_bytes() == b"rename-staging-preparing-window"
        assert not list(folder.glob(".*.photoflow-recovery-*.json"))
        assert not list(folder.glob("*.photoflow-*.part"))

    # Recovery treats directory markers as hostile input. Forged absolute paths,
    # traversal, symlink markers, and invalid schema must never touch a victim.
    for recovery_module in (research_module, rename_module, __import__("catch")):
        with TemporaryDirectory() as temporary_directory:
            parent = Path(temporary_directory)
            allowed = parent / "allowed"
            allowed.mkdir()
            victim = parent / "victim.bin"
            victim.write_bytes(b"do-not-touch")
            operation_id = "a" * 32
            marker = allowed / f".output.jpg.photoflow-recovery-{operation_id}.json"
            forged = {
                "version": 1, "operationId": operation_id, "state": "copying",
                "stagingPath": str(victim), "partialPath": str(victim),
                "recoveryPath": str(victim), "stagingIdentity": None,
                "stagingSize": 12, "stagingDigest": "0" * 64,
                "ownershipIdentity": None, "partialIdentity": None,
            }
            marker.write_text(json.dumps(forged), encoding="utf-8")
            try:
                recovery_module.recover_incomplete_publication(marker, allowed, allowed)
                raise AssertionError("forged external marker must be rejected")
            except (ValueError, OSError, KeyError):
                pass
            assert victim.read_bytes() == b"do-not-touch"

            for suffix, updates in (
                ("bad-version", {"version": 99}),
                ("bad-state", {"state": "move-anything"}),
                ("bad-operation", {"operationId": "b" * 32}),
            ):
                bad = allowed / f".{suffix}.jpg.photoflow-recovery-{operation_id}.json"
                bad.write_text(json.dumps({**forged, **updates}), encoding="utf-8")
                try:
                    recovery_module.recover_incomplete_publication(bad, allowed, allowed)
                    raise AssertionError("invalid recovery schema must be rejected")
                except (ValueError, OSError, KeyError):
                    pass
                assert victim.read_bytes() == b"do-not-touch"

            symlink_marker = allowed / f".symlink.jpg.photoflow-recovery-{operation_id}.json"
            external_payload = parent / "external-marker.json"
            external_payload.write_text(json.dumps(forged), encoding="utf-8")
            try:
                symlink_marker.symlink_to(external_payload)
            except OSError:
                pass
            else:
                try:
                    recovery_module.recover_incomplete_publication(symlink_marker, allowed, allowed)
                    raise AssertionError("symlink recovery marker must be rejected")
                except (ValueError, OSError):
                    pass
                assert victim.read_bytes() == b"do-not-touch"

    output = ReconfigurableStringIO()
    original_process_folders = rename_module.process_folders
    rename_module.process_folders = lambda *_args, **_kwargs: (_ for _ in ()).throw(rename_module.PartialOperationError("injected incomplete operation"))
    try:
        with redirect_stdout(output):
            rename_module.run(["--folder_a", ".", "--folder_b", "."])
    finally:
        rename_module.process_folders = original_process_folders
    terminal_events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]
    assert terminal_events[-1]["type"] == "error"
    assert not any(event["type"] in {"partial", "success"} for event in terminal_events)

    with TemporaryDirectory() as temporary_directory:
        folder = Path(temporary_directory)
        (folder / "reference.jpg").write_bytes(b"reference")
        original_copy = rename_module.copy_file_no_replace
        rename_module.copy_file_no_replace = lambda _source, _destination: (_ for _ in ()).throw(OSError("copy failed"))
        try:
            try:
                rename_module.copy_unmatched_a_files(["reference.jpg"], str(folder))
                raise AssertionError("copy failures must not be swallowed")
            except OSError as error:
                assert "copy failed" in str(error)
        finally:
            rename_module.copy_file_no_replace = original_copy

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

    output = StringIO()
    with redirect_stdout(output):
        log_warning("skipped invalid media", data={"skippedCount": 2})
    assert json.loads(output.getvalue()) == {
        "type": "warning",
        "message": "skipped invalid media",
        "data": {"skippedCount": 2},
    }

    assert unique_stem_index(["IMG_0001.CR3", "img_0001.jpg", "IMG_0002.CR3"]) == {
        "img_0002": "IMG_0002.CR3",
    }, "duplicate stems must remain ambiguous even when extensions or case differ"

    with TemporaryDirectory() as temporary_directory:
        reference_directory = Path(temporary_directory) / "reference"
        source_directory = Path(temporary_directory) / "source"
        reference_directory.mkdir()
        source_directory.mkdir()
        # The RAW is deliberately undecodable: a unique same-stem pair must be
        # resolved before the visual decoder is called.
        (reference_directory / "IMG_1234.CR3").write_bytes(b"raw-placeholder")
        Image.new("RGB", (64, 48), (220, 20, 60)).save(source_directory / "img_1234.jpg")
        original_calculate_hashes = rename_module.calculate_hashes
        rename_module.calculate_hashes = lambda _path: (_ for _ in ()).throw(AssertionError("filename matches must skip visual decoding"))
        output = StringIO()
        try:
            with redirect_stdout(output):
                assert rename_module.process_folders(
                    str(reference_directory), str(source_directory), 5, False, preview_only=True
                )
        finally:
            rename_module.calculate_hashes = original_calculate_hashes
        events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]
        preview = next(event for event in events if event["type"] == "preview")
        assert preview["data"]["matches"] == [{
            "source": "img_1234.jpg",
            "reference": "IMG_1234.CR3",
            "target": "IMG_1234.jpg",
            "confidence": "高",
            "distance": 0,
        }]
        assert any(event["type"] == "log" and "唯一同名主文件名" in event["message"] for event in events)

    with TemporaryDirectory() as temporary_directory:
        reference_directory = Path(temporary_directory) / "reference"
        source_directory = Path(temporary_directory) / "source"
        reference_directory.mkdir()
        source_directory.mkdir()
        Image.new("RGB", (100, 100), (255, 0, 0)).save(reference_directory / "same-name.jpg")
        Image.new("RGB", (200, 100), (0, 0, 255)).save(source_directory / "SAME-NAME.png")
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
        assert preview["data"]["matches"] == [], "obvious same-name aspect conflicts must not auto-match"
        assert any(event["type"] == "log" and "宽高比或拍摄时间不一致" in event["message"] for event in events)

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

        same_folder = project_directory / "legacy-version"
        same_folder.mkdir()
        (same_folder / "DSC_0001.NEF").write_bytes(b"not-a-decodable-raw")
        Image.new("RGB", (20, 16), (18, 72, 120)).save(same_folder / "DSC_0001.jpg")
        same_folder_index = build_jpg_proxy_index(str(same_folder))
        assert visual_reference_path(str(same_folder / "DSC_0001.NEF"), same_folder_index).endswith("DSC_0001.jpg")

        nested_jpg_directory = jpg_directory / "second-card"
        nested_jpg_directory.mkdir()
        Image.new("RGB", (32, 24), (38, 91, 143)).save(nested_jpg_directory / "IMG_1234.jpg")
        for retired_alias in ("jpeg", "preview", "proxy", "预览", "代理", "jpg预览"):
            (project_directory / retired_alias).mkdir()
        proxy_index = build_jpg_proxy_index(str(jpg_directory))
        assert "img_1234" not in proxy_index, "duplicate camera names must not select an unsafe V0 proxy"
        assert find_selection_jpg_proxy_folder(str(reference_directory)) == str(jpg_directory), "only the canonical jpg folder may act as a sibling proxy"
        assert find_selection_jpg_proxy_folder(str(source_directory)) == str(jpg_directory), "retired alias folders must be ignored"
        assert visual_reference_path(str(reference_directory / "IMG_1234.CR3"), proxy_index).endswith("IMG_1234.CR3")
    print("Research worker regression tests passed")


if __name__ == "__main__":
    main()
