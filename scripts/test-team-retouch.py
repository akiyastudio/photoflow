"""Regression test for the component-owned high-resolution Patch merge path."""

from __future__ import annotations

import json
import io
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "components" / "team-retouch" / "team_retouch.py"
sys.path.insert(0, str(ENGINE.parent))
sys.path.insert(0, str(ROOT / "python"))

from team_retouch import centered_work_crop, emit_progress, load_mask, match_returned_batch, maximize_assignment, plan_work_tiles, restore_patches, save_mask  # noqa: E402
from workspace_db import connect, team_patch_replace  # noqa: E402


def main():
    progress_output = io.StringIO()
    with redirect_stdout(progress_output):
        emit_progress(34, "正在确认每个人的位置")
    progress = json.loads(progress_output.getvalue())
    assert progress == {"type": "progress", "progress": 34, "message": "正在确认每个人的位置"}

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
        # This second edit is outside the target-person mask and must not be
        # pasted back even though it is present in the returned work tile.
        edited[8:28, 8:28, 2] = 245

        base_path = test_root / "base.png"
        edited_path = test_root / "edited.png"
        output_path = test_root / "merged.tif"
        manifest_path = test_root / "manifest.json"
        unicode_directory = test_root / "中文路径" / "人物遮罩"
        unicode_directory.mkdir(parents=True)
        mask_path = unicode_directory / "遮罩-01.png"
        Image.fromarray(base, "RGB").save(base_path)
        Image.fromarray(edited, "RGB").save(edited_path)
        restored_path = test_root / "AKI_0555_裁切" / "AKI_0555_人物01.png"
        restore_manifest = test_root / "restore.json"
        restore_manifest.write_text(json.dumps({"tasks": [{
            "id": "restore-task", "crop": crop, "patchPath": str(restored_path),
        }]}), encoding="utf-8")
        restored = restore_patches(base_path, restore_manifest)
        assert restored["restoredCount"] == 1 and restored_path.is_file()
        with Image.open(restored_path) as restored_image:
            assert np.array_equal(np.asarray(restored_image.convert("RGB")), base[crop["y"]:crop["y"] + crop["height"], crop["x"]:crop["x"] + crop["width"]])
        full_mask = np.zeros((height, width), dtype=np.uint8)
        full_mask[80:170, 105:205] = 255
        save_mask(mask_path, full_mask)
        assert np.array_equal(load_mask(mask_path), full_mask)

        # Returned phone images lose names/metadata and may be resized,
        # compressed, blurred and recolored. Content matching must still
        # recover a one-to-one task assignment in arbitrary return order.
        candidates, returned = [], []
        for index in range(4):
            rng = np.random.default_rng(100 + index)
            pixels = np.full((360, 540, 3), (45 + 30 * index, 75 + 12 * index, 105 + 8 * index), dtype=np.uint8)
            pixels = np.clip(pixels + rng.integers(0, 35, pixels.shape, dtype=np.uint8), 0, 255).astype(np.uint8)
            candidate_image = Image.fromarray(pixels, "RGB")
            draw = ImageDraw.Draw(candidate_image)
            draw.ellipse((70 + 30 * index, 50, 270 + 30 * index, 300), fill=(190, 130 + 20 * index, 100), outline="white", width=9)
            draw.rectangle((300 - 20 * index, 80 + 25 * index, 500, 300), outline=(255, 220, 40 + 30 * index), width=15)
            candidate_path = test_root / f"candidate-{index}.png"
            candidate_image.save(candidate_path)
            candidates.append({
                "taskId": f"task-{index}", "photoId": f"photo-{index // 2}",
                "baseVersionId": f"base-{index // 2}", "photoName": f"团片 {index // 2}",
                "personName": f"人物 {index}", "patchPath": str(candidate_path),
            })
        return_order = [2, 0, 3, 1]
        for return_index, candidate_index in enumerate(return_order):
            returned_image = Image.open(test_root / f"candidate-{candidate_index}.png").resize((450, 300))
            returned_image = ImageEnhance.Brightness(returned_image).enhance(1.08)
            returned_image = ImageEnhance.Color(returned_image).enhance(0.82).filter(ImageFilter.GaussianBlur(0.65))
            returned_path = test_root / f"phone-{return_index}.jpg"
            returned_image.save(returned_path, quality=73)
            returned.append({"returnId": f"return-{return_index}", "path": str(returned_path), "sourceName": returned_path.name})
        match_manifest = test_root / "returned-manifest.json"
        match_manifest.write_text(json.dumps({"returned": returned, "candidates": candidates}), encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            matched = match_returned_batch(match_manifest)
        assert [item["taskId"] for item in matched["matches"]] == [f"task-{index}" for index in return_order]
        assert all(item["confidence"] == "high" for item in matched["matches"])
        assert maximize_assignment([[0.9, 0.2], [0.8, 0.7]]) == [0, 1]
        manifest_path.write_text(json.dumps({"tasks": [{
            "id": "test-task",
            "crop": crop,
            "editedPatchPath": str(edited_path),
            "maskPath": str(mask_path),
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
            merged_rgb = np.asarray(merged.convert("RGB"))
        # The masked target edit is retained while the unrelated corner edit
        # remains equal to the high-resolution base image.
        assert np.mean(np.abs(merged_rgb[105:145, 130:175].astype(np.int16) - base[105:145, 130:175].astype(np.int16))) > 1
        assert np.max(np.abs(merged_rgb[58:70, 82:94].astype(np.int16) - base[58:70, 82:94].astype(np.int16))) <= 1

        portrait_crop = centered_work_crop([2400, 2500, 2800, 3300], 6000, 7000)
        assert portrait_crop == [1266, 900, 2667, 4000]
        assert abs(portrait_crop[2] / portrait_crop[3] - 2 / 3) < 0.001
        edge_crop = centered_work_crop([0, 100, 500, 900], 4608, 3074)
        assert edge_crop == [0, 0, 2049, 3074]

        # Nearby people share one normal-size work image, while distant people
        # remain separate. A group can contain at most three people.
        nearby = [{"box": box} for box in (
            [500, 500, 1400, 3200], [1500, 600, 2400, 3250],
        )]
        nearby_tiles = plan_work_tiles(nearby, 8192, 5464)
        assert len(nearby_tiles) == 1 and nearby_tiles[0]["indices"] == [0, 1]
        assert max(nearby_tiles[0]["crop"][2:]) <= 4000

        distant = [{"box": box} for box in (
            [100, 200, 800, 2800], [5000, 200, 5800, 2800],
        )]
        assert len(plan_work_tiles(distant, 8192, 5464)) == 2

        crowd = [{"box": box} for box in (
            [300, 500, 900, 3000], [1000, 500, 1600, 3000], [1700, 500, 2300, 3000],
        )]
        crowd_tiles = plan_work_tiles(crowd, 8192, 5464)
        assert len(crowd_tiles) == 1 and crowd_tiles[0]["indices"] == [0, 1, 2]

        # An individual taller than 4000 px grows beyond the normal limit and
        # remains completely inside the crop.
        oversized_box = [1000, 200, 2000, 4700]
        oversized = centered_work_crop(oversized_box, 6000, 7000)
        assert max(oversized[2:]) > 4000
        assert oversized[0] <= oversized_box[0] and oversized[1] <= oversized_box[1]
        assert oversized[0] + oversized[2] >= oversized_box[2]
        assert oversized[1] + oversized[3] >= oversized_box[3]

        face_centered = plan_work_tiles([{
            "box": oversized_box,
            "faceBox": [1320, 260, 1680, 700],
        }], 6000, 7000, oversize_crop_mode="face-centered")[0]["crop"]
        assert max(face_centered[2:]) <= 4000
        assert face_centered[0] <= 1320 and face_centered[1] <= 260
        assert face_centered[0] + face_centered[2] >= 1680
        assert face_centered[1] + face_centered[3] >= 700

        oversized_pair = plan_work_tiles([
            {"box": [800, 100, 2100, 5200], "faceBox": [1200, 180, 1600, 650]},
            {"box": [2200, 120, 3500, 5250], "faceBox": [2600, 200, 3000, 670]},
        ], 6000, 7000, oversize_crop_mode="face-centered")
        assert len(oversized_pair) == 1 and oversized_pair[0]["indices"] == [0, 1]
        assert max(oversized_pair[0]["crop"][2:]) <= 4000

        # Group membership survives the workspace database round-trip while
        # old databases gain the new column through connect() migration.
        db = connect(str(test_root), str(test_root / "workspace.sqlite3"))
        db.execute("INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                   ("project", "Test", "未分类", "Test", 1, 1))
        db.execute("""INSERT INTO photos(id,project_id,media_type,original_name,display_name,original_file_path,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,?)""",
                   ("photo", "project", "image", "base.png", "base.png", str(base_path), 1, 1))
        db.execute("""INSERT INTO versions(id,photo_id,version_number,version_name,file_path,file_path_key,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,?)""",
                   ("version", "photo", 0, "原片", str(base_path), str(base_path).casefold(), 1, 1))
        db.commit()
        stored = team_patch_replace(db, {"photoId": "photo", "baseVersionId": "version", "tasks": [{
            "id": "group-task", "personIndex": 1, "personName": "人物 1、2", "assignee": "",
            "detector": "test", "bbox": {"x": 10, "y": 10, "width": 100, "height": 100},
            "members": [
                {"personIndex": 1, "bbox": {"x": 10, "y": 10, "width": 40, "height": 90}},
                {"personIndex": 2, "bbox": {"x": 60, "y": 12, "width": 50, "height": 88}},
            ],
            "crop": crop, "patchPath": str(restored_path), "maskPath": str(mask_path),
            "mask": {"width": width, "height": height, "scale": 1}, "status": "exported",
        }]})
        assert [member["personIndex"] for member in stored["tasks"][0]["members"]] == [1, 2]
        db.close()
        print("team-retouch merge regression test passed")


if __name__ == "__main__":
    main()
