import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import zipfile
from io import BytesIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "python" / "office_media_extract.py"
SPEC = importlib.util.spec_from_file_location("office_media_extractor", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


with tempfile.TemporaryDirectory(prefix="photoflow-office-media-") as temporary:
    directory = Path(temporary)
    document = directory / "方案.docx"
    with zipfile.ZipFile(document, "w") as archive:
        archive.writestr("word/document.xml", "<document />")
        archive.writestr("word/media/image1.png", b"png-image")
        archive.writestr("word/media/vector.emf", b"emf-image")
        archive.writestr("word/embeddings/object.bin", b"not-an-image")

    existing = directory / "方案_media"
    existing.mkdir()
    result = MODULE.extract_document(str(document))
    assert result["success"] is True
    assert result["count"] == 2
    output = Path(result["outputFolder"])
    assert output.name == "方案_media_2"
    assert sorted(path.name for path in output.iterdir()) == ["image1.png", "vector.emf"]
    assert existing.exists()

    for file_name, media_path in (("演示.pptx", "ppt/media/photo.jpeg"), ("表格.xlsm", "xl/media/chart.svg")):
        office_document = directory / file_name
        with zipfile.ZipFile(office_document, "w") as archive:
            archive.writestr(media_path, b"office-image")
        office_result = MODULE.extract_document(str(office_document))
        assert office_result["success"] is True
        assert office_result["count"] == 1
        assert Path(office_result["outputFolder"]).joinpath(Path(media_path).name).exists()

    empty_document = directory / "数据.xlsx"
    with zipfile.ZipFile(empty_document, "w") as archive:
        archive.writestr("xl/workbook.xml", "<workbook />")
    empty_result = MODULE.extract_document(str(empty_document))
    assert empty_result["success"] is True
    assert empty_result["count"] == 0
    assert not (directory / "数据_media").exists()

    legacy_document = directory / "旧文档.doc"
    legacy_document.write_bytes(b"legacy")
    legacy_result = MODULE.extract_document(str(legacy_document))
    assert legacy_result["success"] is False
    assert "不支持" in legacy_result["error"]

    cli_result = subprocess.run(
        [sys.executable, str(SOURCE), "extract", "--input", str(document)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    cli_payload = json.loads(cli_result.stdout.decode("utf-8"))
    cli_output = Path(cli_payload["results"][0]["outputFolder"])
    assert cli_payload["success"] is True
    assert "方案_media" in cli_output.name
    assert cli_output.is_dir()
    assert "\ufffd" not in str(cli_output)

    boundary_document = directory / "边界.xlsx"
    with zipfile.ZipFile(boundary_document, "w") as archive:
        for index in range(2000):
            archive.writestr(f"xl/media/图片_{index:04d}.png", b"x")
    boundary_result = MODULE.extract_document(str(boundary_document))
    assert boundary_result["success"] is True
    assert boundary_result["count"] == 2000

    class StdoutCapture:
        def __init__(self):
            self.buffer = BytesIO()

    original_stdout = MODULE.sys.stdout
    capture = StdoutCapture()
    MODULE.sys.stdout = capture
    try:
        MODULE.run(["extract", "--input", str(document), "--input", str(legacy_document)])
    finally:
        MODULE.sys.stdout = original_stdout
    compact_payload_bytes = capture.buffer.getvalue()
    compact_payload = json.loads(compact_payload_bytes.decode("utf-8"))
    assert len(compact_payload["results"]) == 2
    assert any(item["success"] for item in compact_payload["results"])
    assert any(not item["success"] for item in compact_payload["results"])
    assert "方案".encode("utf-8") in compact_payload_bytes
    assert b"\\u65b9\\u6848" not in compact_payload_bytes

    long_name = "图" * 220 + ".jpeg"
    long_document = directory / "长文件名.docx"
    with zipfile.ZipFile(long_document, "w") as archive:
        archive.writestr(f"word/media/{long_name}", b"jpeg")
    long_result = MODULE.extract_document(str(long_document))
    long_output = Path(long_result["files"][0])
    assert long_output.suffix == ".jpeg" and len(long_output.name.encode("utf-8")) <= 180, long_output.name

    cancel_document = directory / "取消.docx"
    with zipfile.ZipFile(cancel_document, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("word/media/large.bin.png", b"x" * (3 * 1024 * 1024))
    cancel_calls = [0]

    def cancel_during_copy():
        cancel_calls[0] += 1
        if cancel_calls[0] >= 4:
            raise RuntimeError("cancelled by test")

    cancelled = MODULE.extract_document(str(cancel_document), cancel_check=cancel_during_copy)
    assert cancelled["success"] is False and "cancelled" in cancelled["error"], cancelled
    assert not list(directory.glob(".取消.photoflow-staging-*")), "cancelled staging must be cleaned"

    cancel_file = directory / "cancel.flag"
    cancel_file.write_text("cancel", encoding="utf-8")
    cancelled_by_file = MODULE.extract_document(str(cancel_document), cancel_file=str(cancel_file))
    assert cancelled_by_file["success"] is False and "取消" in cancelled_by_file["error"], cancelled_by_file

    race_document = directory / "并发.docx"
    with zipfile.ZipFile(race_document, "w") as archive:
        archive.writestr("word/media/image.png", b"complete")
    race_results: list[dict[str, object]] = []
    race_threads = [threading.Thread(target=lambda: race_results.append(MODULE.extract_document(str(race_document)))) for _ in range(2)]
    for thread in race_threads:
        thread.start()
    for thread in race_threads:
        thread.join(timeout=10)
    assert len(race_results) == 2 and all(item["success"] for item in race_results), race_results
    assert len({item["outputFolder"] for item in race_results}) == 2, race_results
    assert not list(directory.glob(".*.photoflow-staging-*")), "staging directories must be cleaned"

    original_native_publish = MODULE._native_rename_no_replace
    if os.name == "nt":
        win_staging = directory / ".native-win-stage"
        win_staging.mkdir()
        win_occupied = directory / "native-win-occupied"
        win_occupied.mkdir()
        try:
            MODULE._native_rename_no_replace(win_staging, win_occupied)
        except FileExistsError:
            pass
        else:
            raise AssertionError("MoveFileExW replaced an existing directory")
        assert win_staging.exists() and win_occupied.exists()

        original_win_dll = MODULE.ctypes.WinDLL
        original_get_last_error = MODULE.ctypes.get_last_error
        observed: dict[str, object] = {}

        class FakeMove:
            def __call__(self, *_args):
                return 0

        class FakeKernel:
            MoveFileExW = FakeMove()

        def fake_win_dll(name, *, use_last_error=False):
            observed.update(name=name, use_last_error=use_last_error)
            return FakeKernel()

        MODULE.ctypes.WinDLL = fake_win_dll
        MODULE.ctypes.get_last_error = lambda: 183
        try:
            try:
                MODULE._native_rename_no_replace(win_staging, directory / "anything")
            except FileExistsError:
                pass
            assert observed == {"name": "kernel32", "use_last_error": True}, observed
        finally:
            MODULE.ctypes.WinDLL = original_win_dll
            MODULE.ctypes.get_last_error = original_get_last_error
    MODULE._native_rename_no_replace = lambda _source, _destination: False
    try:
        unsupported_result = MODULE.extract_document(str(race_document))
        assert unsupported_result["success"] is False
        assert unsupported_result["code"] == "atomic_no_replace_unsupported", unsupported_result
        unsupported_recovery = Path(unsupported_result["recoveryPath"])
        assert unsupported_recovery.is_dir() and unsupported_recovery.joinpath("image.png").exists()
        assert not (directory / "并发_media_3").exists()

        occupied = directory / "occupied"
        occupied.mkdir()
        staging = directory / ".occupied-stage"
        staging.mkdir()
        (staging / "image.png").write_bytes(b"published")
        try:
            MODULE._publish_directory_no_replace(staging, directory, "occupied")
        except MODULE.PublicationUnsupportedError as error:
            assert Path(error.recovery_path) == staging
        else:
            raise AssertionError("non-atomic directory fallback unexpectedly published")
        assert not any(occupied.iterdir()) and staging.joinpath("image.png").read_bytes() == b"published"
        assert not (directory / "occupied_2").exists()

        symlink_target = directory / "symlink-target"
        symlink_target.mkdir()
        symlink_path = directory / "linked-output"
        try:
            os.symlink(symlink_target, symlink_path, target_is_directory=True)
        except OSError:
            junction = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(symlink_path), str(symlink_target)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            assert junction.returncode == 0, junction.stderr
        symlink_stage = directory / ".linked-stage"
        symlink_stage.mkdir()
        (symlink_stage / "vector.emf").write_bytes(b"vector")
        try:
            MODULE._publish_directory_no_replace(symlink_stage, directory, "linked-output")
        except MODULE.PublicationUnsupportedError as error:
            assert Path(error.recovery_path) == symlink_stage
        else:
            raise AssertionError("symlink collision reached a non-atomic directory fallback")
        assert symlink_path.exists() and not any(symlink_target.iterdir())
        assert not (directory / "linked-output_2").exists()
    finally:
        MODULE._native_rename_no_replace = original_native_publish

print("Office media extractor tests passed")
