"""Real FFmpeg smoke test for Unicode video trim paths."""

from __future__ import annotations

import subprocess
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "extensions" / "video-tools" / "runtime"))
sys.path.insert(0, str(ROOT / "python"))

from cut_video import trim_video_exactly  # noqa: E402
from ffmpeg_transcode import probe_duration  # noqa: E402
from ffmpeg_utils import get_ffmpeg_exe  # noqa: E402


def frame_bytes(ffmpeg: str, path: Path, seconds: float) -> bytes:
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", str(seconds), "-i", str(path), "-frames:v", "1", "-vf", "scale=160:90", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0 and result.stdout, result.stderr.decode("utf-8", errors="replace")
    return result.stdout


def mean_absolute_difference(left: bytes, right: bytes) -> float:
    assert len(left) == len(right)
    return sum(abs(a - b) for a, b in zip(left, right)) / len(left)


def main():
    with TemporaryDirectory(prefix="照片流-视频裁剪-") as temporary_directory:
        directory = Path(temporary_directory) / "中文项目" / "待剪辑视频"
        directory.mkdir(parents=True)
        source = directory / "角色生日 录像.mp4"
        output = directory / "角色生日 录像_剪辑.mp4"
        ffmpeg = get_ffmpeg_exe()
        generated = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel", "error",
                "-f", "lavfi",
                "-i", "testsrc2=size=320x180:rate=30,drawbox=x='mod(t*45,280)':y=20:w=40:h=140:color=yellow:t=fill",
                "-t", "6",
                "-c:v", "mpeg4",
                "-g", "30",
                "-q:v", "5",
                "-y",
                str(source),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        assert generated.returncode == 0, generated.stderr
        result = trim_video_exactly(str(source), 1.25, 4.5, str(output))
        assert result["success"] is True
        assert result["exactTranscodeUsed"] is True
        assert output.is_file() and output.stat().st_size > 0
        output_duration = probe_duration(str(output))
        assert 3.13 <= output_duration <= 3.37, output_duration
        source_selected_frame = frame_bytes(ffmpeg, source, 1.25)
        output_first_frame = frame_bytes(ffmpeg, output, 0)
        source_keyframe_frame = frame_bytes(ffmpeg, source, 1.0)
        assert mean_absolute_difference(source_selected_frame, output_first_frame) < mean_absolute_difference(source_keyframe_frame, output_first_frame)
        assert hashlib.sha256(output_first_frame).digest() != hashlib.sha256(source_keyframe_frame).digest()
        source_selected_end_frame = frame_bytes(ffmpeg, source, 4.5 - 1 / 30)
        output_last_frame = frame_bytes(ffmpeg, output, max(0, output_duration - 1 / 30))
        source_early_end_frame = frame_bytes(ffmpeg, source, 4.0)
        assert mean_absolute_difference(source_selected_end_frame, output_last_frame) < mean_absolute_difference(source_early_end_frame, output_last_frame)
        assert source.is_file() and probe_duration(str(source)) >= 5.9

        cancelled_output = directory / "角色生日 录像_取消导出.mp4"
        cancel_file = directory / "取消导出.cancel"
        cancelled_process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "extensions" / "video-tools" / "runtime" / "cut_video.py"),
                str(source),
                "--trim-start", "0.5",
                "--trim-end", "5.5",
                "--output-path", str(cancelled_output),
                "--trim-mode", "exact",
                "--cancel_file", str(cancel_file),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        cancelled_events = []
        for line in cancelled_process.stdout or []:
            event = json.loads(line)
            cancelled_events.append(event)
            if event.get("phase") == "encoding" and not cancel_file.exists():
                cancel_file.write_text("cancel", encoding="utf-8")
        cancelled_process.wait(timeout=15)
        assert cancelled_process.returncode != 0
        assert any(event.get("type") == "cancelled" for event in cancelled_events)
        assert not cancelled_output.exists()
        assert not any(directory.glob("*.photoflow-part.mp4"))
        print(f"Real Unicode video trim passed: {output.name}, {output_duration:.2f}s")


if __name__ == "__main__":
    main()
