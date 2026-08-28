from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import tempfile
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
