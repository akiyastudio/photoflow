"""Decode and resize image/RAW previews outside Electron's main process."""

from __future__ import annotations

import argparse
import io
import json
import mmap
import os
import sys
from pathlib import Path

from PIL import Image, ImageOps


def _embedded_jpeg(source_path: str) -> Image.Image:
    best: tuple[int, int] | None = None
    with open(source_path, "rb") as source:
        with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            start = mapped.find(b"\xff\xd8")
            while start >= 0:
                end = mapped.find(b"\xff\xd9", start + 2)
                if end < 0:
                    break
                length = end + 2 - start
                if best is None or length > best[1]:
                    best = (start, length)
                start = mapped.find(b"\xff\xd8", end + 2)
            if best is None or best[1] < 8 * 1024:
                raise ValueError("RAW 文件中没有可用的内嵌 JPEG 预览")
            payload = mapped[best[0]:best[0] + best[1]]
    with Image.open(io.BytesIO(payload)) as embedded:
        return ImageOps.exif_transpose(embedded).copy()


def _open_source(source_path: str, kind: str) -> Image.Image:
    if kind == "raw":
        return _embedded_jpeg(source_path)
    with Image.open(source_path) as source:
        source.seek(0)
        return ImageOps.exif_transpose(source).copy()


def _rgb(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image
    if "A" in image.getbands():
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=image.getchannel("A"))
        return background
    return image.convert("RGB")


def generate(source_path: str, kind: str, outputs: list[dict]) -> list[dict]:
    image = _rgb(_open_source(source_path, kind))
    generated = []
    try:
        for output in sorted(outputs, key=lambda item: int(item["pixels"]), reverse=True):
            target = os.path.abspath(output["path"])
            pixels = int(output["pixels"])
            Path(target).parent.mkdir(parents=True, exist_ok=True)
            if not os.path.exists(target):
                resized = image.copy()
                if pixels > 0:
                    resized.thumbnail((pixels, pixels), Image.Resampling.LANCZOS)
                temporary = f"{target}.tmp-{os.getpid()}"
                try:
                    resized.save(temporary, format="JPEG", quality=84 if pixels >= 960 else 80,
                                 optimize=True, progressive=True)
                    os.replace(temporary, target)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
                    resized.close()
            generated.append({"sizeLabel": output["sizeLabel"], "pixelSize": pixels, "path": target})
    finally:
        image.close()
    return generated


def run_server() -> None:
    # Electron writes JSONL through UTF-8 pipes. On Chinese Windows, Python's
    # redirected stdio can otherwise inherit the legacy system code page and
    # corrupt paths before json.loads sees them.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            generated = generate(request["source"], request.get("kind", "image"), request["outputs"])
            response = {"id": request.get("id"), "success": True, "generated": generated}
        except Exception as error:
            response = {"id": request.get("id") if isinstance(request, dict) else None,
                        "success": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--source")
    parser.add_argument("--kind", choices=("image", "raw"), default="image")
    parser.add_argument("--outputs")
    args = parser.parse_args(args_list)
    if args.server:
        run_server()
        return
    if not args.source or not args.outputs:
        parser.error("--source and --outputs are required outside server mode")
    outputs = json.loads(args.outputs)
    result = generate(args.source, args.kind, outputs)
    print(json.dumps({"generated": result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    run()
