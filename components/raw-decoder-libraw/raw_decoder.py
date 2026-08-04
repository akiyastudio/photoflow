"""Decode camera RAW sensor data into browser-compatible JPEG files."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import rawpy
from PIL import Image


DECODER_ID = "libraw-rawpy-v1"
HALF_SIZE_LIMIT = 4000


def _exif_orientation(libraw_flip: int) -> int:
    # LibRaw/dcraw use 3 for 180 degrees, 5 for 90 degrees counter-clockwise,
    # and 6 for 90 degrees clockwise. JPEG uses EXIF orientation 8 for the
    # counter-clockwise case.
    return {0: 1, 3: 3, 5: 8, 6: 6}.get(int(libraw_flip or 0), 1)


def _use_half_size(outputs: list[dict]) -> bool:
    requested = [int(output.get("pixels", 0)) for output in outputs]
    return bool(requested) and all(0 < pixels <= HALF_SIZE_LIMIT for pixels in requested)


def decode(source_path: str, outputs: list[dict]) -> list[dict]:
    source = Path(source_path).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"RAW 文件不存在：{source}")
    if not isinstance(outputs, list) or not outputs:
        raise ValueError("没有请求 RAW 解码输出")

    half_size = _use_half_size(outputs)
    with rawpy.imread(str(source)) as raw:
        orientation = _exif_orientation(raw.sizes.flip)
        pixels = raw.postprocess(
            half_size=half_size,
            use_camera_wb=True,
            use_auto_wb=False,
            output_color=rawpy.ColorSpace.sRGB,
            output_bps=8,
            user_flip=0,
        )

    image = Image.fromarray(pixels, mode="RGB")
    generated: list[dict] = []
    try:
        exif = Image.Exif()
        exif[274] = orientation
        exif[305] = f"PhotoFlow {DECODER_ID} / LibRaw {rawpy.libraw_version}"
        for output in sorted(outputs, key=lambda item: int(item.get("pixels", 0)), reverse=True):
            target = Path(str(output["path"])).resolve()
            requested_size = int(output.get("pixels", 0))
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                resized = image.copy()
                try:
                    if requested_size > 0:
                        resized.thumbnail((requested_size, requested_size), Image.Resampling.LANCZOS)
                    temporary = Path(f"{target}.tmp-{os.getpid()}")
                    try:
                        resized.save(
                            temporary,
                            format="JPEG",
                            quality=90 if requested_size == 0 else 84 if requested_size >= 960 else 80,
                            optimize=True,
                            progressive=True,
                            exif=exif,
                        )
                        os.replace(temporary, target)
                    finally:
                        temporary.unlink(missing_ok=True)
                finally:
                    resized.close()
            generated.append({
                "sizeLabel": str(output["sizeLabel"]),
                "pixelSize": requested_size,
                "path": str(target),
                "decoder": DECODER_ID,
                "orientation": orientation,
                "halfSize": half_size,
            })
    finally:
        image.close()
        del pixels
    return generated


def run(args_list=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source")
    parser.add_argument("--outputs")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args(args_list)
    try:
        if args.probe:
            result = {
                "success": True,
                "decoder": DECODER_ID,
                "rawpyVersion": rawpy.__version__,
                "librawVersion": list(rawpy.libraw_version),
            }
        else:
            if not args.source or not args.outputs:
                raise ValueError("必须提供 --source 和 --outputs")
            result = {
                "success": True,
                "decoder": DECODER_ID,
                "rawpyVersion": rawpy.__version__,
                "librawVersion": list(rawpy.libraw_version),
                "generated": decode(args.source, json.loads(args.outputs)),
            }
    except Exception as error:
        result = {"success": False, "decoder": DECODER_ID, "error": str(error)}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
