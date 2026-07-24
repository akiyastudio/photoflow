import datetime
import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from classify import build_capture_groups, stage_import_and_organize, stage_import_broll, stage_plan_import  # noqa: E402


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

    stage_import_broll(str(card), str(project))

    assert not any(dcim.iterdir()), "successful b-roll import should clean the source card"
    assert (project / "花絮" / "7-21" / "clip-one.mp4").is_file()
    assert (project / "花絮" / "7-22" / "clip-two.mp4").is_file()

print("classify b-roll date routing tests passed")


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
        stage_plan_import(str(card), json.dumps(projects, ensure_ascii=False))
    event = json.loads(output.getvalue().strip())
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
    )
    assert not any(dcim.iterdir())
    assert (morning_project / "raw" / "morning.cr3").is_file()
    assert (afternoon_project / "jpg" / "afternoon.jpg").is_file()

print("classify routed work import tests passed")
