"""Central image dimension and memory guards for every retouch worker."""
from __future__ import annotations

import contextlib
import os
from pathlib import Path
from PIL import Image, ImageOps

MAX_DIMENSION = 65_535
MAX_ORIGINAL_PIXELS = 160_000_000
MAX_WORK_PIXELS = 40_000_000
MAX_PROCESS_BYTES = 4 * 1024**3
MEMORY_FRACTION = 0.30
DEFAULT_PEAK_BYTES_PER_PIXEL = 20
Image.MAX_IMAGE_PIXELS = MAX_ORIGINAL_PIXELS


def physical_memory_bytes():
    override = os.environ.get("PHOTOFLOW_TEST_PHYSICAL_MEMORY_BYTES", "").strip()
    if override:
        return max(1, int(override))
    if os.name == "nt":
        import ctypes
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("memory_load", ctypes.c_ulong),
                        ("total_phys", ctypes.c_ulonglong), ("avail_phys", ctypes.c_ulonglong),
                        ("total_page", ctypes.c_ulonglong), ("avail_page", ctypes.c_ulonglong),
                        ("total_virtual", ctypes.c_ulonglong), ("avail_virtual", ctypes.c_ulonglong),
                        ("avail_extended", ctypes.c_ulonglong)]
        status = MemoryStatus(); status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.total_phys)
    try:
        return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
    except (AttributeError, ValueError, OSError):
        return 8 * 1024**3


def validate_dimensions(width, height, *, role="original", peak_bytes_per_pixel=DEFAULT_PEAK_BYTES_PER_PIXEL):
    width, height = int(width), int(height)
    if not (1 <= width <= MAX_DIMENSION and 1 <= height <= MAX_DIMENSION):
        raise ValueError(f"图像尺寸超出安全范围：{width}x{height}（每边须为 1..{MAX_DIMENSION}）")
    pixels = width * height
    pixel_limit = MAX_WORK_PIXELS if role == "work" else MAX_ORIGINAL_PIXELS
    if pixels > pixel_limit:
        raise ValueError(f"{role} 图像像素超出安全上限：{pixels} > {pixel_limit}")
    memory_limit = min(MAX_PROCESS_BYTES, int(physical_memory_bytes() * MEMORY_FRACTION))
    estimate = pixels * max(1, int(peak_bytes_per_pixel))
    if estimate > memory_limit:
        raise ValueError(f"图像估算峰值内存超限：{estimate} > {memory_limit} 字节")
    return width, height


def inspect_dimensions(path, *, role="original", peak_bytes_per_pixel=DEFAULT_PEAK_BYTES_PER_PIXEL):
    with Image.open(Path(path)) as source:
        return validate_dimensions(source.width, source.height, role=role, peak_bytes_per_pixel=peak_bytes_per_pixel)


def inspect_oriented_dimensions(path, *, role="original", peak_bytes_per_pixel=DEFAULT_PEAK_BYTES_PER_PIXEL):
    with Image.open(Path(path)) as source:
        width, height = validate_dimensions(source.width, source.height, role=role, peak_bytes_per_pixel=peak_bytes_per_pixel)
        orientation = int(source.getexif().get(274, 1))
        return (height, width) if orientation in (5, 6, 7, 8) else (width, height)


@contextlib.contextmanager
def open_validated(path, *, role="original", mode=None, max_edge=None, peak_bytes_per_pixel=DEFAULT_PEAK_BYTES_PER_PIXEL):
    with Image.open(Path(path)) as source:
        validate_dimensions(source.width, source.height, role=role, peak_bytes_per_pixel=peak_bytes_per_pixel)
        if max_edge:
            edge = max(1, int(max_edge)); scale = min(1.0, edge / max(source.size))
            target = (max(1, round(source.width * scale)), max(1, round(source.height * scale)))
            try: source.draft(mode or "RGB", target)
            except (AttributeError, ValueError): pass
        source.load()
        image = ImageOps.exif_transpose(source)
        if mode: image = image.convert(mode)
        if max_edge and max(image.size) > max_edge:
            image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS, reducing_gap=3.0)
        yield image


def load_array(path, *, role="original", mode="RGB", max_edge=None, peak_bytes_per_pixel=DEFAULT_PEAK_BYTES_PER_PIXEL):
    import numpy as np
    with open_validated(path, role=role, mode=mode, max_edge=max_edge, peak_bytes_per_pixel=peak_bytes_per_pixel) as image:
        return np.asarray(image).copy()
