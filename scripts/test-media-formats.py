from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image
from pi_heif import register_heif_opener


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

register_heif_opener(thumbnails=False)

from thumbnail_image import generate  # noqa: E402


ENCODABLE_FORMATS = {
    "webp": "WEBP",
    "avif": "AVIF",
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
        for extension in ("heic", "heif", "hif"):
            source = root / f"source.{extension}"
            source.write_bytes(HEIC_SAMPLE)
            sources.append(source)

        for source in sources:
            extension = source.suffix.removeprefix(".")
            target = root / f"preview-{extension}.jpg"
            if args.runtime:
                generate_with_runtime(args.runtime, source, target)
            else:
                generate(str(source), "image", [{"sizeLabel": "test", "pixels": 96, "path": str(target)}])
            assert_jpeg(target)
            print(f"ok: {extension}")


if __name__ == "__main__":
    main()
