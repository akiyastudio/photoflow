from __future__ import annotations

import argparse
import base64
import errno
import io
import json
import subprocess
import sys
import tempfile
import threading
from contextlib import redirect_stdout
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from thumbnail_image import HEIF_DECODER_AVAILABLE, generate  # noqa: E402
from png_to_jpg import run as run_image_converter  # noqa: E402


ENCODABLE_FORMATS = {
    "jpg": "JPEG",
    "png": "PNG",
    "webp": "WEBP",
    "tiff": "TIFF",
}

# A valid 32x24 HEIC image generated once for this regression test. Keeping the
# small fixture inline lets CI verify the decode-only pi-heif runtime without
# installing the much larger HEIF/x265 encoding stack.
HEIC_SAMPLE = base64.b64decode(
    "AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAXxtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0"
    "AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoAABAAAAAAAAADcAAAAjaWluZgAAAAAA"
    "AQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/GlwcnAAAADcaXBjbwAAAHVodmND"
    "AQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQApQgEB"
    "A3AAAAMAkAAAAwAAAwAeoCCBBZbqrprm4CGgwIAAAAyAAAADAIRiAAEABkQBwXPBiQAAABNjb2xybmNs"
    "eAABAA0ABoAAAAAUaXNwZQAAAAAAAABAAAAAQAAAAChjbGFwAAAAIAAAAAEAAAAYAAAAAf///+AAAAAC"
    "////2AAAAAIAAAAQcGl4aQAAAAADCAgIAAAAGGlwbWEAAAAAAAAAAQABBYECAwWEAAAAP21kYXQAAAAz"
    "KAGvBjIWhzSJIPC/U8f9f+NT///dKSs1snrhH6Bjx+S3kJGe9F97GFLlPHQg9JxTuc2A"
)


def create_source(path: Path, image_format: str) -> None:
    image = Image.new("RGB", (128, 80))
    try:
        pixels = image.load()
        for y in range(image.height):
            for x in range(image.width):
                pixels[x, y] = ((x * 3 + y) % 256, (x + y * 5) % 256, (x * 7 + y * 2) % 256)
        image.save(path, format=image_format, quality=90)
    finally:
        image.close()


def assert_jpeg(path: Path) -> None:
    with Image.open(path) as decoded:
        decoded.load()
        assert decoded.format == "JPEG", f"{path.name} is not a JPEG preview"
        assert decoded.mode == "RGB", f"{path.name} was not normalized to RGB"
        assert max(decoded.size) <= 96, f"{path.name} was not resized"


def generate_with_runtime(runtime: Path, source: Path, target: Path) -> None:
    outputs = [{"sizeLabel": "test", "pixels": 96, "path": str(target)}]
    completed = subprocess.run(
        [str(runtime), "thumbnail_image", "--source", str(source), "--outputs", json.dumps(outputs)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout


def assert_worker_protocol(jpeg_source: Path, heif_source: Path, root: Path) -> None:
    worker = subprocess.Popen(
        [sys.executable, str(ROOT / "python" / "thumbnail_image.py"), "--server"],
        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8",
    )
    assert worker.stdin is not None and worker.stdout is not None
    try:
        jpeg_target = root / "worker-jpg.jpg"
        worker.stdin.write(json.dumps({"id": "jpg", "source": str(jpeg_source), "kind": "image", "outputs": [{"sizeLabel": "test", "pixels": 96, "path": str(jpeg_target)}]}) + "\n")
        worker.stdin.flush()
        jpeg_response = json.loads(worker.stdout.readline())
        assert jpeg_response["success"] is True, jpeg_response
        assert_jpeg(jpeg_target)

        heif_target = root / "worker-heif.jpg"
        worker.stdin.write(json.dumps({"id": "heif", "source": str(heif_source), "kind": "image", "outputs": [{"sizeLabel": "test", "pixels": 96, "path": str(heif_target)}]}) + "\n")
        worker.stdin.flush()
        heif_response = json.loads(worker.stdout.readline())
        if HEIF_DECODER_AVAILABLE:
            assert heif_response["success"] is True, heif_response
            assert_jpeg(heif_target)
        else:
            assert heif_response["success"] is False and "pi-heif" in heif_response["error"], heif_response
    finally:
        worker.terminate()
        worker.wait(timeout=10)


def assert_image_converter(root: Path) -> None:
    converter_root = root / "converter"
    converter_root.mkdir()
    create_source(converter_root / "web.webp", "WEBP")
    create_source(converter_root / "photo.tiff", "TIFF")
    create_source(converter_root / "bitmap.bmp", "BMP")
    create_source(converter_root / "animation.gif", "GIF")
    transparent = Image.new("RGBA", (40, 30), (255, 0, 0, 0))
    transparent.putpixel((20, 15), (255, 0, 0, 255))
    transparent.save(converter_root / "transparent.png", format="PNG")
    transparent.close()

    collision_source = converter_root / "collision.png"
    create_source(collision_source, "PNG")
    create_source(converter_root / "collision.jpg", "JPEG")

    heic_source = converter_root / "phone.heic"
    heic_source.write_bytes(HEIC_SAMPLE)
    run_image_converter(["--quality", "90", "--keep-original", str(converter_root)])

    expected = ["web.jpg", "photo.jpg", "bitmap.jpg", "animation.jpg", "transparent.jpg", "collision_转换.jpg"]
    if HEIF_DECODER_AVAILABLE:
        expected.append("phone.jpg")
    for name in expected:
        target = converter_root / name
        with Image.open(target) as decoded:
            decoded.load()
            assert decoded.format == "JPEG", f"{name} is not a JPEG"
            assert decoded.mode == "RGB", f"{name} was not normalized to RGB"

    with Image.open(converter_root / "transparent.jpg") as decoded:
        corner = decoded.convert("RGB").getpixel((0, 0))
        assert min(corner) >= 240, f"transparent pixels were not composited onto white: {corner}"
    assert collision_source.exists(), "--keep-original must preserve source images"

    # Animated inputs retain the historical first-frame conversion, but the
    # source must be protected unless deletion was explicitly made safe.
    animated = converter_root / "multi.gif"
    frames = [Image.new("RGB", (24, 18), color) for color in ("red", "blue")]
    frames[0].save(animated, save_all=True, append_images=frames[1:], duration=20, loop=0)
    for frame in frames:
        frame.close()
    output = io.StringIO()
    with redirect_stdout(output):
        run_image_converter([str(animated)])
    events = [json.loads(line) for line in output.getvalue().splitlines()]
    warning = next(event for event in events if event["type"] == "warning")
    assert warning["data"]["frameCount"] == 2 and warning["data"]["sourceProtected"] is True, warning
    assert animated.exists(), "multi-frame originals are protected by default"

    # Concurrent writers targeting the same preferred name must each publish
    # a complete JPEG and never replace the first process' file.
    concurrent = converter_root / "parallel.png"
    create_source(concurrent, "PNG")
    barrier = threading.Barrier(2)
    thread_state = threading.local()
    original_save = __import__("png_to_jpg").save_verified_jpeg

    def synchronized_save(*args, **kwargs):
        if not getattr(thread_state, "synchronized", False):
            thread_state.synchronized = True
            barrier.wait(timeout=5)
        return original_save(*args, **kwargs)

    module = __import__("png_to_jpg")
    module.save_verified_jpeg = synchronized_save
    try:
        threads = [threading.Thread(target=lambda: run_image_converter(["--keep-original", str(concurrent)])) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        assert all(not thread.is_alive() for thread in threads)
    finally:
        module.save_verified_jpeg = original_save
    parallel_outputs = sorted(converter_root.glob("parallel*.jpg"))
    assert len(parallel_outputs) == 2, parallel_outputs
    for target in parallel_outputs:
        with Image.open(target) as decoded:
            decoded.load()
            assert decoded.format == "JPEG"

    fallback_stage = converter_root / ".fallback.tmp"
    fallback_target = converter_root / "fallback.jpg"
    fallback_stage.write_bytes(b"complete-jpeg-bytes")
    original_link = module.os.link
    module.os.link = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError(errno.EOPNOTSUPP, "links unsupported"))
    try:
        try:
            module.publish_file_no_replace(fallback_stage, fallback_target)
        except module.PublicationUnsupportedError as error:
            assert error.code == "atomic_no_replace_unsupported"
            assert Path(error.recovery_path) == fallback_stage
        else:
            raise AssertionError("unsupported filesystem published a visible final file")
        assert not fallback_target.exists() and fallback_stage.read_bytes() == b"complete-jpeg-bytes"

        unsupported_root = converter_root / "unsupported"
        unsupported_root.mkdir()
        unsupported_source = unsupported_root / "source.png"
        create_source(unsupported_source, "PNG")
        unsupported_output = io.StringIO()
        with redirect_stdout(unsupported_output):
            run_image_converter(["--keep-original", str(unsupported_source)])
        unsupported_events = [json.loads(line) for line in unsupported_output.getvalue().splitlines()]
        publication_error = next(event for event in unsupported_events if event.get("data", {}).get("code") == "atomic_no_replace_unsupported")
        assert Path(publication_error["data"]["recoveryPath"]).exists(), publication_error
        assert not list(unsupported_root.glob("*.jpg"))
    finally:
        module.os.link = original_link

    timestamp_root = converter_root / "timestamp"
    timestamp_root.mkdir()
    timestamp_source = timestamp_root / "source.png"
    create_source(timestamp_source, "PNG")
    original_utime = module.os.utime
    module.os.utime = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("timestamps unsupported"))
    timestamp_output = io.StringIO()
    try:
        with redirect_stdout(timestamp_output):
            run_image_converter(["--keep-original", str(timestamp_source)])
    finally:
        module.os.utime = original_utime
    timestamp_events = [json.loads(line) for line in timestamp_output.getvalue().splitlines()]
    assert len(list(timestamp_root.glob("*.jpg"))) == 1
    assert any(event.get("type") == "warning" and event.get("data", {}).get("code") == "timestamp_preservation_failed" for event in timestamp_events)
    assert timestamp_events[-1]["type"] == "success", timestamp_events

    # Batch completion has exactly one terminal outcome. A failed source is
    # retained while successfully published inputs follow the requested cleanup.
    mixed_root = converter_root / "mixed"
    mixed_root.mkdir()
    valid_source = mixed_root / "valid.png"
    damaged_source = mixed_root / "damaged.png"
    create_source(valid_source, "PNG")
    damaged_source.write_bytes(b"\x89PNG\r\n\x1a\ntruncated")
    trashed_sources = []
    original_send2trash = module.send2trash

    def record_trash(path):
        trashed_sources.append(Path(path).resolve())
        Path(path).unlink()

    module.send2trash = record_trash
    mixed_output = io.StringIO()
    try:
        with redirect_stdout(mixed_output):
            run_image_converter([str(valid_source), str(damaged_source)])
    finally:
        module.send2trash = original_send2trash
    mixed_events = [json.loads(line) for line in mixed_output.getvalue().splitlines()]
    assert [event["type"] for event in mixed_events] == ["log", "progress", "warning", "partial"], mixed_events
    assert mixed_events[-1]["data"] == {
        "successCount": 1,
        "failedCount": 1,
        "totalCount": 2,
        "failedSources": [str(damaged_source.resolve())],
    }
    assert trashed_sources == [valid_source.resolve()]
    assert not valid_source.exists() and damaged_source.exists(), "only the successfully converted source may be removed"

    failed_output = io.StringIO()
    with redirect_stdout(failed_output):
        run_image_converter([str(damaged_source)])
    failed_events = [json.loads(line) for line in failed_output.getvalue().splitlines()]
    assert [event["type"] for event in failed_events] == ["log", "warning", "error"], failed_events
    assert failed_events[-1]["data"]["successCount"] == 0
    assert failed_events[-1]["data"]["failedCount"] == failed_events[-1]["data"]["totalCount"] == 1
    assert damaged_source.exists(), "an all-failed batch must retain its source"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, help="optional packaged tools executable")
    args = parser.parse_args()
    if args.runtime:
        assert args.runtime.is_file(), f"runtime does not exist: {args.runtime}"

    with tempfile.TemporaryDirectory(prefix="photoflow-formats-") as temporary:
        root = Path(temporary)
        sources: list[Path] = []
        for extension, image_format in ENCODABLE_FORMATS.items():
            source = root / f"source.{extension}"
            create_source(source, image_format)
            sources.append(source)
        heif_extensions = ("heic", "heif", "hif", "avif")
        for extension in heif_extensions:
            source = root / f"source.{extension}"
            if extension == "avif" and HEIF_DECODER_AVAILABLE:
                create_source(source, "AVIF")
            else:
                source.write_bytes(HEIC_SAMPLE)
            sources.append(source)

        for source in sources:
            extension = source.suffix.removeprefix(".")
            target = root / f"preview-{extension}.jpg"
            if not HEIF_DECODER_AVAILABLE and source.suffix.removeprefix(".") in heif_extensions and not args.runtime:
                try:
                    generate(str(source), "image", [{"sizeLabel": "test", "pixels": 96, "path": str(target)}])
                except RuntimeError as error:
                    assert "pi-heif" in str(error)
                else:
                    raise AssertionError(f"{source.name} unexpectedly decoded without pi-heif")
                print(f"expected dependency error: {extension}")
                continue
            if args.runtime:
                generate_with_runtime(args.runtime, source, target)
            else:
                generate(str(source), "image", [{"sizeLabel": "test", "pixels": 96, "path": str(target)}])
            assert_jpeg(target)
            print(f"ok: {extension}")
        assert_worker_protocol(root / "source.jpg", root / "source.heic", root)
        assert_image_converter(root)


if __name__ == "__main__":
    main()
