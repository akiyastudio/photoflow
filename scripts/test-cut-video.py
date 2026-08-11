"""Regression checks for batch video-split input expansion."""

from __future__ import annotations

import sys
import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import cut_video  # noqa: E402


def main():
    child_environment = os.environ.copy()
    child_environment["PYTHONIOENCODING"] = "gbk"
    utf8_probe = subprocess.run(
        [
            sys.executable,
            "-c",
            f"import sys; sys.path.insert(0, {str(ROOT / 'python')!r}); import cut_video; cut_video.emit('log', '视频大小 4.86 GB，预计分为 2 段')",
        ],
        capture_output=True,
        env=child_environment,
        check=True,
    )
    decoded_probe = json.loads(utf8_probe.stdout.decode("utf-8"))
    assert decoded_probe["message"] == "视频大小 4.86 GB，预计分为 2 段"

    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        nested = root / "nested"
        nested.mkdir()
        first = root / "first.mp4"
        second = nested / "second.mov"
        unsupported = root / "notes.txt"
        first.write_bytes(b"video-one")
        second.write_bytes(b"video-two")
        unsupported.write_text("notes", encoding="utf-8")

        videos, skipped = cut_video.collect_video_inputs([str(root), str(second), str(unsupported)])
        assert videos == [str(first), str(second)]
        assert skipped == [str(unsupported)]

        calls = []
        events = []
        original_split = cut_video.fast_lossless_split
        original_emit = cut_video.emit
        cut_video.fast_lossless_split = lambda video_path, **kwargs: calls.append((video_path, kwargs["progress_range"], kwargs["emit_completion"])) or [f"{video_path}.part"]
        cut_video.emit = lambda event_type, message, progress=None, **extra: events.append((event_type, message, progress, extra))
        try:
            result = cut_video.run([str(root), str(second)])
        finally:
            cut_video.fast_lossless_split = original_split
            cut_video.emit = original_emit

        assert result == 0
        assert calls == [
            (str(first), (0.0, 50.0), False),
            (str(second), (50.0, 100.0), False),
        ]
        assert events[-1][0] == "success" and events[-1][2] == 100
        assert events[-1][3] == {"outputsCount": 2, "failedCount": 0}

        cancel_file = root / "cancel.flag"
        cancel_file.write_text("cancel", encoding="utf-8")
        cancellation_events = []
        original_emit = cut_video.emit
        cut_video.emit = lambda event_type, message, progress=None, **extra: cancellation_events.append(event_type)
        try:
            assert cut_video.run([str(first), "--cancel_file", str(cancel_file)]) == 1
        finally:
            cut_video.emit = original_emit
        assert cancellation_events == ["cancelled"]

    print("Video split batch-input regression tests passed")


if __name__ == "__main__":
    main()
