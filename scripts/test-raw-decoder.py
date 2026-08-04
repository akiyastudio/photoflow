from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "python" / "raw_decoder.py"
POSTPROCESS_CALLS: list[dict] = []


class FakeRaw:
    sizes = types.SimpleNamespace(flip=6)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def postprocess(self, **kwargs):
        POSTPROCESS_CALLS.append(kwargs)
        pixels = np.zeros((24, 32, 3), dtype=np.uint8)
        pixels[:, :, 0] = np.arange(32, dtype=np.uint8)
        return pixels


fake_rawpy = types.SimpleNamespace(
    __version__="0.27.0",
    libraw_version=(0, 21, 4),
    ColorSpace=types.SimpleNamespace(sRGB="sRGB"),
    imread=lambda _path: FakeRaw(),
)
sys.modules["rawpy"] = fake_rawpy
spec = importlib.util.spec_from_file_location("photoflow_raw_decoder", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


with tempfile.TemporaryDirectory(prefix="photoflow-raw-decoder-") as temporary:
    root = Path(temporary)
    source = root / "camera.cr3"
    source.write_bytes(b"test RAW container")

    thumbnail = root / "thumbnail.jpg"
    generated = module.decode(str(source), [{"sizeLabel": "small", "pixels": 16, "path": str(thumbnail)}])
    assert generated[0]["decoder"] == "libraw-rawpy-v1"
    assert generated[0]["halfSize"] is True
    assert POSTPROCESS_CALLS[-1]["half_size"] is True
    assert POSTPROCESS_CALLS[-1]["use_camera_wb"] is True
    assert POSTPROCESS_CALLS[-1]["output_color"] == "sRGB"
    assert POSTPROCESS_CALLS[-1]["output_bps"] == 8
    assert POSTPROCESS_CALLS[-1]["user_flip"] == 0
    with Image.open(thumbnail) as image:
        assert max(image.size) <= 16
        assert image.getexif().get(274) == 6
        assert "PhotoFlow libraw-rawpy-v1" in image.getexif().get(305, "")

    full = root / "full.jpg"
    module.decode(str(source), [{"sizeLabel": "full", "pixels": 0, "path": str(full)}])
    assert POSTPROCESS_CALLS[-1]["half_size"] is False
    with Image.open(full) as image:
        assert image.size == (32, 24)

print("Built-in RAW decoder tests passed")
