"""Regression checks for batch video-split input expansion."""

from __future__ import annotations

import sys
import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock


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
        source = root / "variable-bitrate.mp4"
        source.write_bytes(b"0123456789")
        segment_times = []

        class FakeProcess:
            def __init__(self, command):
                pattern = command[-1]
                segment_times.append(float(command[command.index("-segment_time") + 1]))
                sizes = (7, 3) if len(segment_times) == 1 else (5, 5)
                for index, size in enumerate(sizes):
                    Path(pattern.replace("%03d", f"{index:03d}")).write_bytes(b"x" * size)
                self.stdout = ["out_time_us=1000000\n"]

            def wait(self):
                return 0

            def poll(self):
                return 0

            def terminate(self):
                return None

        events = []
        with mock.patch.object(cut_video, "TARGET_SIZE", 5), \
                mock.patch.object(cut_video, "MAXIMUM_SIZE", 6), \
                mock.patch.object(cut_video, "probe_duration", return_value=10.0), \
                mock.patch.object(cut_video, "get_ffmpeg_exe", return_value="ffmpeg"), \
                mock.patch.object(cut_video.subprocess, "Popen", side_effect=lambda command, **_kwargs: FakeProcess(command)), \
                mock.patch.object(cut_video, "emit", side_effect=lambda event_type, message, progress=None, **extra: events.append((event_type, message, progress, extra))):
            outputs = cut_video.fast_lossless_split(str(source))

        assert len(segment_times) == 2 and segment_times[1] < segment_times[0]
        assert [Path(path).name for path in outputs] == ["variable-bitrate_part000.mp4", "variable-bitrate_part001.mp4"]
        assert all(Path(path).stat().st_size <= 6 for path in outputs)
        assert not any(root.glob(".photoflow-split-*"))
        assert any(event[0] == "warning" and "超过 3.95 GB" in event[1] for event in events)

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
