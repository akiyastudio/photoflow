"""Regression coverage for preview crop save/Save As and atomic failures."""
import importlib.util
import tempfile
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location(
    "crop_save", Path(__file__).resolve().parents[1] / "python" / "screenshot_main_image.py"
)
crop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crop)

with tempfile.TemporaryDirectory(prefix="photoflow-crop-save-") as directory:
    root = Path(directory)
    source = root / "原图.png"
    pixels = np.arange(120 * 100 * 3, dtype=np.uint8).reshape(120, 100, 3)
    cv2.imencode(".png", pixels)[1].tofile(source)
    original = source.read_bytes()

    saved_copy = crop.crop_main_image(str(source), "10,20,40,50", "裁剪")
    assert saved_copy["success"], saved_copy
    assert Path(saved_copy["output"]) != source
    assert source.read_bytes() == original
    assert np.array_equal(crop._read_image(Path(saved_copy["output"])), pixels[20:70, 10:50])

    with patch.object(crop.os, "replace", side_effect=PermissionError("locked source")):
        failed = crop.crop_main_image(str(source), "10,20,40,50", "裁剪", True)
    assert not failed["success"], failed
    assert source.read_bytes() == original
    assert not list(root.glob("*.photoflow-part"))

    old_stat = source.stat()
    source.write_bytes(original + b"changed")
    changed = source.read_bytes()
    try:
        crop._write_image_atomic(source, pixels[:40, :40], source, expected_source_stat=old_stat)
        raise AssertionError("A changed original must be rejected")
    except RuntimeError as error:
        assert "原图已发生变化" in str(error), error
    assert source.read_bytes() == changed
    source.write_bytes(original)

    result = crop.crop_main_image(str(source), "10,20,40,50", "裁剪", True)
    assert result["success"] and Path(result["output"]) == source, result
    assert np.array_equal(crop._read_image(source), pixels[20:70, 10:50])
    assert len(list(root.iterdir())) == 2, "Save must not create a second copy or leave staging files"

print("Preview crop Save, Save As, changed-original and locked-original tests passed.")
