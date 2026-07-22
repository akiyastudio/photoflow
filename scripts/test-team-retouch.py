"""Regression test for the component-owned high-resolution Patch merge path."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "components" / "team-retouch" / "team_retouch.py"


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-team-retouch-test-") as directory:
        test_root = Path(directory)
        width, height = 320, 240
        x_axis = np.linspace(20, 220, width, dtype=np.uint8)
        y_axis = np.linspace(15, 180, height, dtype=np.uint8)
        base = np.empty((height, width, 3), dtype=np.uint8)
        base[..., 0] = x_axis[None, :]
        base[..., 1] = y_axis[:, None]
        base[..., 2] = 110
        crop = {"x": 72, "y": 48, "width": 160, "height": 144}
        edited = base[crop["y"]:crop["y"] + crop["height"], crop["x"]:crop["x"] + crop["width"]].copy()
        edited[42:102, 48:112, 0] = np.clip(edited[42:102, 48:112, 0].astype(np.int16) + 24, 0, 255)
        edited[42:102, 48:112, 1] = np.clip(edited[42:102, 48:112, 1].astype(np.int16) - 12, 0, 255)

        base_path = test_root / "base.png"
        edited_path = test_root / "edited.png"
        output_path = test_root / "merged.tif"
        manifest_path = test_root / "manifest.json"
        Image.fromarray(base, "RGB").save(base_path)
        Image.fromarray(edited, "RGB").save(edited_path)
        manifest_path.write_text(json.dumps({"tasks": [{
            "id": "test-task",
            "crop": crop,
            "editedPatchPath": str(edited_path),
        }]}), encoding="utf-8")

        result = subprocess.run([
            sys.executable, str(ENGINE), "merge",
            "--input", str(base_path),
            "--manifest", str(manifest_path),
            "--output", str(output_path),
        ], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8")
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        assert payload["success"] is True
        assert payload["mergedCount"] == 1
        assert payload["width"] == width and payload["height"] == height
        assert output_path.is_file()
        with Image.open(output_path) as merged:
            assert merged.size == (width, height)
        print("team-retouch merge regression test passed")


if __name__ == "__main__":
    main()
