import datetime
import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "extensions" / "video-tools" / "runtime"))
sys.path.insert(0, str(ROOT / "python"))

import classify  # noqa: E402
from classify import build_capture_groups, generate_missing_raw_jpgs, stage_import_and_organize, stage_import_broll, stage_plan_import  # noqa: E402
from ffmpeg_transcode import build_video_preview_command  # noqa: E402
from PIL import Image  # noqa: E402


assert not classify._is_import_volume_root(str(ROOT)), 'an ordinary application directory must not be detected as an SD-card volume root'


for quality, expected in {
    'medium': ('4M', '5M', '128k', 'medium'),
    'high': ('10M', '12M', '192k', 'medium'),
}.items():
    command = build_video_preview_command('ffmpeg', 'input.mov', 'output.mp4', quality)
    assert command[command.index('-b:v') + 1] == expected[0]
    assert command[command.index('-maxrate') + 1] == expected[1]
    assert command[command.index('-b:a') + 1] == expected[2]
    assert command[command.index('-preset') + 1] == expected[3]
assert build_video_preview_command('ffmpeg', 'input.mov', 'output.mp4', 'unknown') == build_video_preview_command('ffmpeg', 'input.mov', 'output.mp4', 'medium')


with tempfile.TemporaryDirectory(prefix="photoflow-classify-test-") as temporary:
    root = Path(temporary)
    card = root / "card"
    dcim = card / "DCIM"
    project = root / "project with a non-date name"
    dcim.mkdir(parents=True)
    project.mkdir()

    samples = [
        ("clip-one.mp4", datetime.datetime(2026, 7, 21, 18, 30)),
        ("clip-two.mp4", datetime.datetime(2026, 7, 22, 9, 15)),
    ]
    for name, captured_at in samples:
        source = dcim / name
        source.write_bytes(name.encode("utf-8"))
        timestamp = captured_at.timestamp()
        os.utime(source, (timestamp, timestamp))

    stage_import_broll(str(card), str(project), delete_source=True)

    assert not any(dcim.iterdir()), "successful b-roll import should clean the source card"
    assert (project / "花絮" / "clip-one.mp4").is_file()
    assert (project / "花絮" / "clip-two.mp4").is_file()

print("classify b-roll date routing tests passed")


with tempfile.TemporaryDirectory(prefix="photoflow-broll-source-policy-test-") as temporary:
    root = Path(temporary)
    card = root / "card"
    dcim = card / "DCIM"
    project = root / "project"
    dcim.mkdir(parents=True)
    project.mkdir()
    source = dcim / "keep-source.mp4"
    source.write_bytes(b"source-policy")

    stage_import_broll(str(card), str(project))

    assert source.is_file(), "backend must retain sources unless deletion was explicitly requested"
    assert (project / "花絮" / source.name).is_file()

print("classify explicit source deletion policy tests passed")


with tempfile.TemporaryDirectory(prefix="photoflow-work-source-policy-test-") as temporary:
    root = Path(temporary)
    card = root / "card"
    dcim = card / "DCIM"
    project = root / "project"
    dcim.mkdir(parents=True)
    project.mkdir()
    source = dcim / "keep-source.jpg"
    source.write_bytes(b"source-policy")

    stage_import_and_organize(str(card), str(project), direct_project=True)

    assert source.is_file(), "work import must retain sources unless deletion was explicitly requested"
    assert (project / "jpg" / source.name).is_file()

print("classify work import source retention tests passed")


with tempfile.TemporaryDirectory(prefix="photoflow-raw-jpg-test-") as temporary:
    root = Path(temporary)
    raw_folder = root / "raw"
    jpg_folder = root / "jpg"
    raw_folder.mkdir()
    jpg_folder.mkdir()

    embedded = io.BytesIO()
    Image.effect_noise((640, 480), 100).convert("RGB").save(embedded, format="JPEG", quality=95)
    assert len(embedded.getvalue()) > 8 * 1024
    missing_pair = raw_folder / "missing.CR3"
    missing_pair.write_bytes(b"raw-prefix" + embedded.getvalue() + b"raw-suffix")
    existing_pair = raw_folder / "paired.CR3"
    existing_pair.write_bytes(b"raw-prefix" + embedded.getvalue() + b"raw-suffix")
    (jpg_folder / "PAIRED.jpeg").write_bytes(embedded.getvalue())

    succeeded, candidates = generate_missing_raw_jpgs(root, [missing_pair, existing_pair])

    assert (succeeded, candidates) == (1, 1), "only an imported RAW without a same-stem JPG should be converted"
    generated = jpg_folder / "missing.jpg"
    assert generated.is_file()
    with Image.open(generated) as image:
        assert image.size == (640, 480)

print("classify RAW-to-JPG generation tests passed")


with tempfile.TemporaryDirectory(prefix="photoflow-raw-jpg-import-test-") as temporary:
    root = Path(temporary)
    card = root / "card"
    dcim = card / "DCIM"
    project = root / "project"
    dcim.mkdir(parents=True)
    project.mkdir()
    embedded = io.BytesIO()
    Image.effect_noise((640, 480), 100).convert("RGB").save(embedded, format="JPEG", quality=95)
    source = dcim / "camera.CR3"
    source.write_bytes(b"raw-prefix" + embedded.getvalue() + b"raw-suffix")

    stage_import_and_organize(str(card), str(project), direct_project=True, generate_jpg_from_raw=True)

    assert (project / "raw" / "camera.CR3").is_file()
    assert (project / "jpg" / "camera.jpg").is_file(), "generated JPG must be saved in the project-root jpg folder"
    assert source.is_file(), "RAW-to-JPG generation must not change the selected source retention policy"

print("classify RAW-to-JPG import integration tests passed")


with tempfile.TemporaryDirectory(prefix="photoflow-routing-plan-test-") as temporary:
    root = Path(temporary)
    card = root / "card"
    dcim = card / "DCIM"
    dcim.mkdir(parents=True)
    samples = [
        ("morning.cr3", datetime.datetime(2026, 7, 17, 9, 0)),
        ("morning-2.cr3", datetime.datetime(2026, 7, 17, 10, 0)),
        ("afternoon.cr3", datetime.datetime(2026, 7, 17, 14, 30)),
    ]
    for name, captured_at in samples:
        source = dcim / name
        source.write_bytes(name.encode("utf-8"))
        os.utime(source, (captured_at.timestamp(), captured_at.timestamp()))

    groups = build_capture_groups([str(path) for path in dcim.iterdir()])
    assert [group["count"] for group in groups] == [2, 1]
    assert [group["id"] for group in groups] == ["2026-07-17:1", "2026-07-17:2"]

    projects = [
        {"name": "26-7-17 上午", "path": str(root / "morning"), "projectDate": {"year": 2026, "month": 7, "day": 17, "precision": "day"}},
        {"name": "26-7-17 下午", "path": str(root / "afternoon"), "projectDate": {"year": 2026, "month": 7, "day": 17, "precision": "day"}},
        {"name": "26-7 月度项目", "path": str(root / "month"), "projectDate": {"year": 2026, "month": 7, "precision": "month"}},
    ]
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        stage_plan_import(str(card), str(root), json.dumps(projects, ensure_ascii=False), import_session='routing-plan')
    events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]
    event = next(event for event in events if event["type"] == "ask_user")
    assert any(event["type"] == "progress" for event in events)
    assert event["type"] == "ask_user"
    assert event["data"]["requiresChoice"] is True
    assert len(event["data"]["groups"]) == 2
    assert all(len(group["exactProjectPaths"]) == 2 for group in event["data"]["groups"])

print("classify project-date planning tests passed")


with tempfile.TemporaryDirectory(prefix="photoflow-work-routing-test-") as temporary:
    root = Path(temporary)
    card = root / "card"
    dcim = card / "DCIM"
    morning_project = root / "26-7-17 morning"
    afternoon_project = root / "26-7-17 afternoon"
    dcim.mkdir(parents=True)
    morning_project.mkdir()
    afternoon_project.mkdir()
    for name, captured_at in (
        ("morning.cr3", datetime.datetime(2026, 7, 17, 9, 0)),
        ("afternoon.jpg", datetime.datetime(2026, 7, 17, 14, 0)),
    ):
        source = dcim / name
        source.write_bytes(name.encode("utf-8"))
        os.utime(source, (captured_at.timestamp(), captured_at.timestamp()))

    stage_import_and_organize(
        str(card),
        str(root),
        project_routes={
            "2026-07-17:1": str(morning_project),
            "2026-07-17:2": str(afternoon_project),
        },
        delete_source=True,
    )
    assert not any(dcim.iterdir())
    assert (morning_project / "raw" / "morning.cr3").is_file()
    assert (afternoon_project / "jpg" / "afternoon.jpg").is_file()

print("classify routed work import tests passed")


with tempfile.TemporaryDirectory(prefix="photoflow-import-cancel-test-") as temporary:
    root = Path(temporary)
    source = root / "cancel-source.mp4"
    project = root / "project"
    cancel_file = root / "cancel.flag"
    source.write_bytes(b"source-must-remain")
    project.mkdir()
    cancel_file.write_text("cancel", encoding="utf-8")
    classify.CANCEL_FILE = str(cancel_file)
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output):
            stage_import_broll(str(source), str(project), direct_source=True, source_paths=[str(source)], delete_source=True)
    finally:
        classify.CANCEL_FILE = ""
    events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip().startswith("{")]
    assert any(event.get("type") == "cancelled" for event in events)
    assert source.is_file(), "cancelled import must not delete the source"
    assert not any((project / "花絮").rglob("*.mp4")) if (project / "花絮").exists() else True

print("classify cooperative cancellation tests passed")
