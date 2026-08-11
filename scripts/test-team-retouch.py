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

from team_retouch import bounded_planning_box, box_coverage_by_crop, centered_work_crop, emit_progress, excluded_detection_indices, face_shoulder_planning_box, identify_people, load_mask, mask_bounds, match_returned_batch, matches_exclusion, maximize_assignment, plan_work_tiles, rebuild_without_person, reposition_crop_to_avoid_bystanders, restore_patches, save_mask, spatially_order_people  # noqa: E402
from identity_engine import constrained_clusters, ranked_similarity_pairs  # noqa: E402
from patch_merge import safe_exif_bytes, save_tiff  # noqa: E402
from workspace_db import connect, team_identity_assign, team_identity_complete, team_identity_confirm_group, team_identity_save, team_patch_delete, team_patch_replace, team_patch_update, team_person_exclusion_add, team_person_exclusion_clear, team_person_exclusion_list, team_project_register_photo, team_project_unregister_photo, team_project_workspace  # noqa: E402


def main():
    progress_output = io.StringIO()
    with redirect_stdout(progress_output):
        emit_progress(34, "正在确认每个人的位置")
    progress = json.loads(progress_output.getvalue())
    assert progress == {"type": "progress", "progress": 34, "message": "正在确认每个人的位置"}
    assert matches_exclusion([10, 10, 60, 100], [12, 8, 62, 102])
    assert not matches_exclusion([10, 10, 60, 100], [120, 10, 170, 100])
    overlapping_people = [{"box": [10, 10, 60, 100]}, {"box": [20, 10, 70, 100]}]
    assert excluded_detection_indices(overlapping_people, [[10, 10, 60, 100]]) == {0}

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

        # Removing one false positive must deterministically retain every other
        # stored person. Legacy tasks have only a group mask, so this also
        # covers the compatibility path used by already-recognized projects.
        rebuild_mask_path = test_root / "legacy-group-mask.png"
        legacy_mask = np.zeros((height, width), dtype=np.uint8)
        legacy_members = []
        for person_index, x in enumerate((20, 120, 220), start=1):
            legacy_mask[55:205, x:x + 60] = 255
            legacy_members.append({
                "personIndex": person_index,
                "confidence": 0.9,
                "bbox": {"x": x, "y": 55, "width": 60, "height": 150},
            })
        save_mask(rebuild_mask_path, legacy_mask)
        rebuild_request = test_root / "rebuild-request.json"
        rebuild_request.write_text(json.dumps({
            "removePersonIndex": 2,
            "detector": "legacy-test",
            "tasks": [{
                "id": "legacy-task",
                "personIndex": 1,
                "confidence": 0.9,
                "bbox": {"x": 20, "y": 55, "width": 260, "height": 150},
                "members": legacy_members,
                "maskPath": str(rebuild_mask_path),
            }],
        }), encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            rebuilt = rebuild_without_person(
                base_path, rebuild_request, test_root / "rebuilt-analysis",
                test_root / "rebuilt-delivery", "8196", "expand",
            )
        assert rebuilt["removedPersonCount"] == 1
        assert rebuilt["personCount"] == 2
        rebuilt_members = [member for task in rebuilt["tasks"] for member in task["members"]]
        assert sorted(member["previousPersonIndex"] for member in rebuilt_members) == [1, 3]
        assert sorted(member["personIndex"] for member in rebuilt_members) == [1, 2]
        assert all(Path(task["patchPath"]).is_file() and Path(task["maskPath"]).is_file() for task in rebuilt["tasks"])

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
        assert all(item["alternatives"] and item["alternatives"][0]["patchPath"] for item in matched["matches"])
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

        # Corrupt source offsets are omitted. If any unexpected EXIF block
        # still reaches the writer, saving retries without EXIF.
        class CorruptExif(dict):
            def get_ifd(self, _tag):
                raise OSError("invalid EXIF IFD offset")

        class CorruptExifImage:
            def getexif(self):
                return CorruptExif({271: "PhotoFlow Test", 34665: 18446744073709551615})

        portable_exif = safe_exif_bytes(CorruptExifImage())
        assert portable_exif and b"PhotoFlow Test" in portable_exif
        fallback_path = test_root / "invalid-exif-fallback.tif"
        save_tiff(fallback_path, base, {"exif": b"not-exif", "dpi": (300, 300)})
        with Image.open(fallback_path) as fallback_image:
            assert fallback_image.size == (width, height)

        portrait_crop = centered_work_crop([2400, 2500, 2800, 3300], 6000, 7000)
        assert 2500 <= max(portrait_crop[2:]) < 4000
        assert any(abs(portrait_crop[2] / portrait_crop[3] - ratio) < 0.001 for ratio in (1 / 2, 2 / 3))
        edge_crop = centered_work_crop([0, 100, 500, 900], 4608, 3074)
        assert edge_crop[0] == 0 and 2500 <= max(edge_crop[2:]) < 4000

        # When there is empty space on one side, slide the crop away from an
        # adjacent bystander instead of cutting half of that person into view.
        focus_box = [3000, 500, 3500, 2500]
        bystander_box = [3600, 500, 4100, 2500]
        shifted_crop = reposition_crop_to_avoid_bystanders(
            [2500, 100, 1867, 2800], focus_box, 6000, 4000, [bystander_box],
        )
        assert box_coverage_by_crop(bystander_box, shifted_crop) == 0

        # Hair, props and flowing clothes can extend outside a detector's body
        # box. The segmentation extent must enlarge the planning boundary.
        proxy_mask = np.zeros((100, 200), dtype=bool)
        proxy_mask[10:91, 20:181] = True
        assert mask_bounds(proxy_mask, 0.25, 1200, 800) == [80.0, 40.0, 724.0, 364.0]

        # Detector output order and leaked instance masks must not scramble a
        # crowd. Numbering follows the actual body boxes from left to right,
        # while a contaminated mask can enlarge its body only within bounds.
        unordered_people = [
            {"box": [1700, 500, 2200, 3000], "physicalRank": 2},
            {"box": [300, 600, 800, 3000], "physicalRank": 0},
            {"box": [1000, 450, 1500, 3000], "physicalRank": 1},
        ]
        assert [item["physicalRank"] for item in spatially_order_people(unordered_people)] == [0, 1, 2]
        bounded = bounded_planning_box(
            [1700, 500, 2200, 3000], [250, 300, 2250, 3200], 8192, 5464,
        )
        assert bounded[0] >= 1475 and bounded[2] <= 2425

        # Nearby people share one normal-size work image, while distant people
        # remain separate. Dense neighboring people may share a tile.
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

        # A dense lineup must be split into spatially continuous groups. The
        # planner used to optimize tile count first and could produce groups
        # such as 3/6/8 whose crop visibly contained several unassigned people.
        lineup = [{"box": [300 + index * 650, 500, 800 + index * 650, 2700]} for index in range(9)]
        lineup_tiles = plan_work_tiles(lineup, 8192, 5464)
        assert [tile["indices"] for tile in lineup_tiles] == [[0, 1, 2], [3, 4, 5], [6, 7, 8]]
        for tile in lineup_tiles:
            selected = set(tile["indices"])
            crop = tile["crop"]
            crop_box = [crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]]
            for index, item in enumerate(lineup):
                if index in selected:
                    continue
                box = item["box"]
                overlap_width = max(0, min(box[2], crop_box[2]) - max(box[0], crop_box[0]))
                overlap_height = max(0, min(box[3], crop_box[3]) - max(box[1], crop_box[1]))
                assert overlap_width * overlap_height == 0

        # Detection indices are not necessarily left-to-right because poses
        # change vertical centers. Grouping must still follow spatial order.
        staggered = [{
            "box": [300 + index * 650, top, 800 + index * 650, top + 2000],
            "physicalRank": index,
        } for index, top in enumerate((800, 300, 900, 350, 1000, 400, 1100, 450, 1200))]
        detection_order = sorted(staggered, key=lambda item: ((item["box"][1] + item["box"][3]) / 2, (item["box"][0] + item["box"][2]) / 2))
        staggered_tiles = plan_work_tiles(detection_order, 8192, 5464)
        assert len(staggered_tiles) == 3
        for tile in staggered_tiles:
            ranks = sorted(detection_order[index]["physicalRank"] for index in tile["indices"])
            assert ranks[-1] - ranks[0] + 1 == len(ranks)

        # Regression geometry from a real nine-person edge case: person 7 is
        # at the right image boundary, so a fixed 2:3 crop necessarily showed
        # roughly 75% of person 5. Adaptive square/narrow crops must keep the
        # plan to three tiles while making person 7's tile clean.
        edge_group_boxes = [
            [3712, 2033, 4760, 4696], [2866, 2238, 3820, 4476],
            [4628, 2564, 5340, 4320], [2020, 2612, 2728, 4288],
            [6184, 2584, 6744, 4380], [292, 2570, 1338, 4424],
            [7076, 2510, 7732, 4588], [5416, 3110, 6504, 4680],
            [1008, 3186, 2276, 4652],
        ]
        edge_group_items = [{"box": box, "planningBox": box} for box in edge_group_boxes]
        edge_group_tiles = plan_work_tiles(edge_group_items, 8192, 5464)
        assert len(edge_group_tiles) == 3
        person_seven_tile = next(tile for tile in edge_group_tiles if 6 in tile["indices"])
        assert box_coverage_by_crop(edge_group_boxes[4], person_seven_tile["crop"]) == 0
        person_two_tile = next(tile for tile in edge_group_tiles if 1 in tile["indices"])
        assert person_two_tile["crop"][1] <= edge_group_boxes[1][1] - 80
        for tile in edge_group_tiles:
            for index, box in enumerate(edge_group_boxes):
                if index not in tile["indices"]:
                    assert box_coverage_by_crop(box, tile["crop"]) < 0.8

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
        assert max(face_centered[2:]) == 4000
        assert face_centered[0] <= 1320 and face_centered[1] <= 260
        assert face_centered[0] + face_centered[2] >= 1680
        assert face_centered[1] + face_centered[3] >= 700
        protected = face_shoulder_planning_box({
            "box": oversized_box, "faceBox": [1320, 260, 1680, 700],
        }, 6000, 7000)
        assert box_coverage_by_crop(protected, face_centered) == 1

        oversized_pair = plan_work_tiles([
            {"box": [800, 100, 2100, 5200], "faceBox": [1200, 180, 1600, 650]},
            {"box": [2200, 120, 3500, 5250], "faceBox": [2600, 200, 3000, 670]},
        ], 6000, 7000, oversize_crop_mode="face-centered")
        assert len(oversized_pair) == 1
        assert oversized_pair[0]["indices"] == [0, 1]
        assert all(max(tile["crop"][2:]) == 4000 for tile in oversized_pair)


        # Keeping the 4000px limit protects each person's head and shoulders.
        # If those protected regions do not fit together, split the lineup
        # instead of trimming people at a work-image edge.
        wide_oversized = [
            {"box": [100, 100, 1700, 5200], "faceBox": [650, 180, 1050, 650]},
            {"box": [1750, 120, 3350, 5220], "faceBox": [2300, 200, 2700, 670]},
            {"box": [3400, 140, 5000, 5240], "faceBox": [3950, 220, 4350, 690]},
        ]
        wide_tiles = plan_work_tiles(
            wide_oversized, 6000, 7000, oversize_crop_mode="face-centered",
        )
        assert len(wide_tiles) == 2
        assert all(max(tile["crop"][2:]) == 4000 for tile in wide_tiles)
        for tile in wide_tiles:
            for index in tile["indices"]:
                shoulder_box = face_shoulder_planning_box(wide_oversized[index], 6000, 7000)
                assert box_coverage_by_crop(shoulder_box, tile["crop"]) == 1
        expanded_oversized_pair = plan_work_tiles([
            {"box": [800, 100, 2100, 5200], "faceBox": [1200, 180, 1600, 650]},
            {"box": [2200, 120, 3500, 5250], "faceBox": [2600, 200, 3000, 670]},
        ], 6000, 7000, oversize_crop_mode="expand")
        assert len(expanded_oversized_pair) == 1
        assert expanded_oversized_pair[0]["indices"] == [0, 1]
        assert max(expanded_oversized_pair[0]["crop"][2:]) > 4000
        assert all(box_coverage_by_crop(item["box"], expanded_oversized_pair[0]["crop"]) == 1 for item in [
            {"box": [800, 100, 2100, 5200]}, {"box": [2200, 120, 3500, 5250]},
        ])

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
        uploaded_path = test_root / "uploaded-group.png"
        Image.fromarray(edited, "RGB").save(uploaded_path)
        uploaded = team_patch_update(db, {
            "taskId": "group-task", "editedPatchPath": str(uploaded_path), "status": "uploaded",
        })
        assert uploaded["tasks"][0]["editedPatchPath"] == str(uploaded_path.resolve())
        removed = team_patch_update(db, {
            "taskId": "group-task", "editedPatchPath": None, "status": "exported",
            "mergedVersionId": None, "mergeMetrics": {},
        })
        assert removed["tasks"][0]["editedPatchPath"] is None
        assert removed["tasks"][0]["status"] == "exported"
        adjusted_crop = {"x": 64, "y": 40, "width": 176, "height": 152}
        adjusted = team_patch_update(db, {"taskId": "group-task", "crop": adjusted_crop, "needsReview": False})
        assert adjusted["tasks"][0]["crop"] == adjusted_crop

        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        assert len(workspace["photos"]) == 1 and len(workspace["photos"][0]["tasks"]) == 1
        identity = team_identity_save(db, {
            "projectName": "Test", "name": "Alice", "assignments": [{
                "photoId": "photo", "baseVersionId": "version", "personIndex": 1,
                "confidence": 1, "source": "manual",
            }],
        })
        assert identity["success"]
        atomic_uploaded = team_patch_update(db, {
            "taskId": "group-task", "editedPatchPath": str(uploaded_path), "status": "uploaded",
            "assignmentCompletion": {"personIndex": 1, "completed": True},
        })
        assert atomic_uploaded["tasks"][0]["editedPatchPath"] == str(uploaded_path.resolve())
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        returned_assignment = next(item for item in workspace["assignments"] if item["personIndex"] == 1)
        assert returned_assignment["completed"] is True
        assert returned_assignment["completionKind"] == "returned"
        assert returned_assignment["editedPatchPath"] == str(uploaded_path.resolve())
        atomic_removed = team_patch_update(db, {
            "taskId": "group-task", "editedPatchPath": None, "status": "exported",
            "assignmentCompletion": {"personIndex": 1, "completed": False},
        })
        assert atomic_removed["tasks"][0]["editedPatchPath"] is None
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        removed_assignment = next(item for item in workspace["assignments"] if item["personIndex"] == 1)
        assert removed_assignment["completed"] is False
        assert removed_assignment["completionKind"] == ""
        assert removed_assignment["editedPatchPath"] is None
        assert team_identity_complete(db, {
            "photoId": "photo", "baseVersionId": "version", "personIndex": 1, "completed": True,
        })["success"]
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        assert workspace["identities"][0]["name"] == "Alice"
        assert workspace["assignments"][0]["completed"] is True
        assert workspace["assignments"][0]["completionKind"] == "no-retouch"
        assert workspace["assignments"][0]["editedPatchPath"] is None

        candidate = team_identity_save(db, {
            "projectName": "Test", "name": "\u5f85\u786e\u8ba4\u4eba\u7269 8", "assignments": [{
                "photoId": "photo", "baseVersionId": "version", "personIndex": 2,
                "confidence": .8, "source": "suggested",
            }],
        })
        assert candidate["success"]
        confirmed_candidate = team_identity_confirm_group(db, {
            "projectName": "Test",
            "anchorSubjectKey": "photo:version:2",
            "identityId": candidate["identityId"],
            "assignments": [{
                "photoId": "photo", "baseVersionId": "version", "personIndex": 2,
                "confidence": 1,
            }],
        })
        assert confirmed_candidate["updatedCount"] == 1
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        confirmed_assignment = next(item for item in workspace["assignments"] if item["personIndex"] == 2)
        assert confirmed_assignment["source"] == "manual"
        assert team_identity_assign(db, {
            "projectName": "Test", "photoId": "photo", "baseVersionId": "version", "personIndex": 2,
            "identityId": identity["identityId"], "confidence": .7, "source": "suggested",
        })["success"]
        released_candidate = team_identity_confirm_group(db, {
            "projectName": "Test",
            "anchorSubjectKey": "photo:version:1",
            "identityId": identity["identityId"],
            "assignments": [{
                "photoId": "photo", "baseVersionId": "version", "personIndex": 1,
                "confidence": 1,
            }],
            "clearAssignments": [{
                "photoId": "photo", "baseVersionId": "version", "personIndex": 2,
            }],
        })
        assert released_candidate["updatedCount"] == 1
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        assert all(item["personIndex"] != 2 for item in workspace["assignments"])
        assert team_identity_assign(db, {
            "projectName": "Test", "photoId": "photo", "baseVersionId": "version", "personIndex": 2,
            "identityId": identity["identityId"], "confidence": 1, "source": "manual",
        })["success"]
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        assert all(item["id"] != candidate["identityId"] for item in workspace["identities"])
        excluded = team_person_exclusion_add(db, {
            "projectName": "Test", "photoId": "photo", "baseVersionId": "version",
            "bbox": {"x": 60, "y": 12, "width": 50, "height": 88},
        })
        assert excluded["success"]
        exclusions = team_person_exclusion_list(db, {
            "projectName": "Test", "photoId": "photo", "baseVersionId": "version",
        })
        assert len(exclusions["exclusions"]) == 1
        assert exclusions["exclusions"][0]["bbox"]["width"] == 50
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        assert workspace["photos"][0]["excludedPersonCount"] == 1
        assert team_person_exclusion_clear(db, {
            "projectName": "Test", "photoId": "photo", "baseVersionId": "version",
        })["clearedCount"] == 1

        db.execute("""INSERT INTO photos(id,project_id,media_type,original_name,display_name,original_file_path,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,?)""",
                   ("empty-photo", "project", "image", "empty.png", "empty.png", str(base_path), 1, 1))
        db.execute("""INSERT INTO versions(id,photo_id,version_number,version_name,file_path,file_path_key,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,?)""",
                   ("empty-version", "empty-photo", 0, "原片", str(base_path), str(base_path).casefold() + ":empty", 1, 1))
        db.commit()
        try:
            team_project_register_photo(db, {"projectName": "Test", "photoId": "empty-photo", "baseVersionId": "empty-version"})
            raise AssertionError("photo without an AI crop task was registered")
        except ValueError as error:
            assert "尚未产生实际裁剪任务" in str(error)
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        assert all(photo["photoId"] != "empty-photo" for photo in workspace["photos"])

        identity_a = np.zeros((180, 240, 3), dtype=np.uint8)
        identity_b = identity_a.copy()
        different = identity_a.copy()
        first_identity_path = test_root / "identity-a.png"
        second_identity_path = test_root / "identity-b.png"
        different_identity_path = test_root / "identity-other.png"
        Image.fromarray(identity_a, "RGB").save(first_identity_path)
        Image.fromarray(identity_b, "RGB").save(second_identity_path)
        Image.fromarray(different, "RGB").save(different_identity_path)
        identify_manifest = test_root / "identify.json"
        identify_manifest.write_text(json.dumps({"subjects": [
            {"key": "a", "photoId": "photo-a", "path": str(first_identity_path), "bbox": {"x": 10, "y": 5, "width": 220, "height": 170}},
            {"key": "b", "photoId": "photo-b", "path": str(second_identity_path), "bbox": {"x": 10, "y": 5, "width": 220, "height": 170}},
            {"key": "c", "photoId": "photo-b", "path": str(different_identity_path), "bbox": {"x": 10, "y": 5, "width": 220, "height": 170}},
        ]}), encoding="utf-8")
        class FakeIdentityRuntime:
            provider = "test"

            def describe(self, _rgb, item):
                vector = np.asarray([1, 0, 0], dtype=np.float32) if item["key"] in {"a", "b"} else np.asarray([0, 1, 0], dtype=np.float32)
                return {
                    "key": item["key"], "photoId": item["photoId"], "manualIdentityId": None,
                    "face": vector, "faceQuality": .9, "faceBox": None,
                    "body": vector, "bodyQuality": .9,
                }

            def embed_bodies(self, _descriptors):
                return None

        with redirect_stdout(io.StringIO()):
            clustered = identify_people(identify_manifest, runtime=FakeIdentityRuntime())
        groups = [{member["key"] for member in cluster["members"]} for cluster in clustered["clusters"]]
        assert groups == [{"a", "b"}]
        assert clustered["unmatchedCount"] == 1
        same_photo = [
            {"key": "x", "photoId": "one", "manualIdentityId": None, "face": np.asarray([1, 0], dtype=np.float32), "faceQuality": .9, "body": np.asarray([1, 0], dtype=np.float32), "bodyQuality": .9},
            {"key": "y", "photoId": "one", "manualIdentityId": None, "face": np.asarray([1, 0], dtype=np.float32), "faceQuality": .9, "body": np.asarray([1, 0], dtype=np.float32), "bodyQuality": .9},
        ]
        assert constrained_clusters(same_photo) == []
        conflicting_manual = [
            {**same_photo[0], "photoId": "one", "manualIdentityId": "alice"},
            {**same_photo[1], "photoId": "two", "manualIdentityId": "bob"},
        ]
        assert constrained_clusters(conflicting_manual) == []
        gallery = [
            {"key": "alice-front", "photoId": "p1", "manualIdentityId": "alice", "face": np.asarray([1, 0], dtype=np.float32), "faceQuality": .9, "body": np.asarray([1, 0], dtype=np.float32), "bodyQuality": .9},
            {"key": "alice-profile", "photoId": "p2", "manualIdentityId": "alice", "face": np.asarray([.17, .985], dtype=np.float32), "faceQuality": .9, "body": np.asarray([0, 1], dtype=np.float32), "bodyQuality": .9},
            {"key": "alice-new", "photoId": "p3", "manualIdentityId": None, "face": np.asarray([1, 0], dtype=np.float32), "faceQuality": .9, "body": np.asarray([1, 0], dtype=np.float32), "bodyQuality": .9},
        ]
        gallery_clusters = constrained_clusters(gallery)
        assert len(gallery_clusters) == 1
        assert {item["key"] for item in gallery_clusters[0]["members"]} == {"alice-front", "alice-profile", "alice-new"}
        assert gallery_clusters[0]["evidence"] == "manual-gallery"

        ambiguous = [
            {"key": "alice", "photoId": "a", "manualIdentityId": "alice", "face": np.asarray([1, 0], dtype=np.float32), "faceQuality": .9, "body": np.asarray([1, 0], dtype=np.float32), "bodyQuality": .9},
            {"key": "bob", "photoId": "b", "manualIdentityId": "bob", "face": np.asarray([.99, .141], dtype=np.float32), "faceQuality": .9, "body": np.asarray([1, 0], dtype=np.float32), "bodyQuality": .9},
            {"key": "unknown", "photoId": "c", "manualIdentityId": None, "face": np.asarray([1, 0], dtype=np.float32), "faceQuality": .9, "body": np.asarray([1, 0], dtype=np.float32), "bodyQuality": .9},
        ]
        assert constrained_clusters(ambiguous) == []
        ranked = ranked_similarity_pairs([
            {**same_photo[0], "photoId": "one"},
            {**same_photo[1], "photoId": "two"},
            {**same_photo[1], "key": "z", "photoId": "three", "face": np.asarray([0, 1], dtype=np.float32), "body": np.asarray([0, 1], dtype=np.float32)},
        ])
        assert ranked[0]["leftKey"] == "x" and ranked[0]["rightKey"] == "y"
        assert ranked[0]["score"] > ranked[-1]["score"]
        deleted = team_patch_delete(db, {"taskId": "group-task"})
        assert deleted["tasks"] == []
        assert str(restored_path.resolve()) in deleted["artifactPaths"]
        workspace = team_project_workspace(str(test_root), db, {"projectName": "Test"})
        assert not workspace["assignments"]
        db.close()
        print("team-retouch merge regression test passed")


if __name__ == "__main__":
    main()
