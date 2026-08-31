import os
import sys
import tempfile
from pathlib import Path
from contextlib import redirect_stdout
from io import StringIO
import json


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))

import catch
from catch import TaskCancelled, build_selection_plan, execute_plan, filename_selection_key, parse_search_names


class ReconfigurableStringIO(StringIO):
    def reconfigure(self, **_kwargs):
        return None


def main():
    assert parse_search_names("618A7394.JPG") == ["7394"]
    assert parse_search_names("老师，我的选图618A7394.JPG") == ["7394"]
    assert parse_search_names("7488 7490 7488") == ["7488", "7490"]
    assert parse_search_names("IMG_1234.CR3, 813A8464") == ["1234", "8464"]
    assert parse_search_names("7488-7490") == ["7488", "7490"]
    assert parse_search_names("白柳 黑桃") == []
    assert filename_selection_key("618A7394.JPG") == "7394"
    assert filename_selection_key("618A.JPG") is None

    with tempfile.TemporaryDirectory() as project:
        raw = os.path.join(project, "raw")
        mov = os.path.join(project, "mov")
        os.makedirs(os.path.join(raw, "a"))
        os.makedirs(os.path.join(raw, "b"))
        os.makedirs(mov)
        for relative_path in (
            "raw/618A7394.JPG",
            "raw/813A8464.CR3",
            "raw/813A8464.XMP",
            "raw/a/IMG_9001.CR3",
            "raw/b/IMG_9001.CR3",
            "mov/clip8464.mov",
        ):
            path = os.path.join(project, *relative_path.split("/"))
            with open(path, "wb") as output:
                output.write(relative_path.encode("utf-8"))
        image_target = os.path.join(project, "图片选片")
        os.makedirs(image_target)
        with open(os.path.join(image_target, "618A7394.JPG"), "wb") as output:
            output.write(b"existing")

        plan = build_selection_plan(project, "图片选片", "视频选片", "raw", "mov", ["618", "7394", "8464", "9001"])
        assert plan["missing"] == ["618"]
        assert [item["name"] for item in plan["existing"]] == ["618A7394.JPG"]
        assert [item["name"] for item in plan["files"]] == ["813A8464.CR3"]
        assert plan["conflicts"] == ["IMG_9001.CR3"]
        assert all(not item["source"].lower().endswith(".xmp") for item in plan["files"])
        assert all(not item["source"].lower().endswith(".mov") for item in plan["files"])

    with tempfile.TemporaryDirectory() as project:
        source = os.path.join(project, "raw")
        os.makedirs(source)
        for name in ("IMG_1001.CR3", "IMG_1002.CR3"):
            with open(os.path.join(source, name), "wb") as output:
                output.write(name.encode("utf-8"))
        plan = build_selection_plan(project, "图片选片", "视频选片", "raw", "", ["1001", "1002"])
        original_copy = catch.copy_file_atomically
        copy_calls = 0

        def cancel_after_first(source_path, destination, cancel_file, on_bytes):
            nonlocal copy_calls
            copy_calls += 1
            if copy_calls == 2:
                raise TaskCancelled()
            return original_copy(source_path, destination, cancel_file, on_bytes)

        catch.copy_file_atomically = cancel_after_first
        try:
            try:
                execute_plan(plan)
                raise AssertionError("Expected cancellation")
            except TaskCancelled:
                pass
        finally:
            catch.copy_file_atomically = original_copy
        assert not os.path.exists(os.path.join(project, "图片选片", "IMG_1001.CR3"))
        assert not os.path.exists(os.path.join(project, "图片选片", "IMG_1002.CR3"))

    with tempfile.TemporaryDirectory() as project:
        raw = Path(project) / "raw"
        raw.mkdir()
        (raw / "IMG_1001.CR3").write_bytes(b"owned")
        try:
            build_selection_plan(project, "../escape", "视频选片", "raw", "", ["1001"])
            raise AssertionError("path-traversing destination names must be rejected")
        except ValueError:
            pass

    # A destination created after preview must win the atomic no-replace race.
    with tempfile.TemporaryDirectory() as project:
        source = Path(project) / "source.bin"
        destination = Path(project) / "destination.bin"
        source.write_bytes(b"source")
        original_native = catch.try_atomic_rename_no_replace
        def conflict_publish(_src, dst):
            Path(dst).write_bytes(b"concurrent")
            raise FileExistsError("concurrent destination")
        catch.try_atomic_rename_no_replace = conflict_publish
        try:
            try:
                catch.copy_file_atomically(str(source), str(destination), None, lambda _count: None)
                raise AssertionError("concurrent destination must prevent publication")
            except FileExistsError:
                pass
        finally:
            catch.try_atomic_rename_no_replace = original_native
        assert destination.read_bytes() == b"concurrent"

    # Rollback must not delete a foreign file that replaced an output created by
    # this run before a later item failed.
    with tempfile.TemporaryDirectory() as project:
        raw = Path(project) / "raw"
        raw.mkdir()
        for name in ("IMG_1001.CR3", "IMG_1002.CR3"):
            (raw / name).write_bytes(name.encode("ascii"))
        plan = build_selection_plan(project, "图片选片", "视频选片", "raw", "", ["1001", "1002"])
        first_destination = Path(plan["files"][0]["destination"])
        original_copy = catch.copy_file_atomically
        calls = 0
        def replace_then_fail(source_path, destination, cancel_file, on_bytes):
            nonlocal calls
            calls += 1
            if calls == 2:
                first_destination.unlink()
                first_destination.write_bytes(b"foreign")
                raise OSError("injected copy failure")
            return original_copy(source_path, destination, cancel_file, on_bytes)
        catch.copy_file_atomically = replace_then_fail
        try:
            try:
                execute_plan(plan)
                raise AssertionError("expected injected copy failure")
            except catch.CopyTransactionError as error:
                assert len(error.rollback_errors) == 1
        finally:
            catch.copy_file_atomically = original_copy
        assert first_destination.read_bytes() == b"foreign"

    # No hard-link capability must not make a valid destination unusable.
    with tempfile.TemporaryDirectory() as project:
        source = Path(project) / "source.bin"
        destination = Path(project) / "destination.bin"
        source.write_bytes(b"fallback")
        original_link = catch.os.link
        original_native = catch.try_atomic_rename_no_replace
        catch.os.link = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("hard links unavailable"))
        catch.try_atomic_rename_no_replace = lambda _source, _destination: False
        try:
            token = catch.copy_file_atomically(str(source), str(destination), None, lambda _count: None)
        finally:
            catch.os.link = original_link
            catch.try_atomic_rename_no_replace = original_native
        assert destination.read_bytes() == b"fallback"
        assert token["publication"] == "safe-fallback"

    # Mid-copy failure after O_EXCL publication plus persistent cleanup failure
    # must retain full staging and report a failed rollback with a recovery marker.
    with tempfile.TemporaryDirectory() as project:
        raw = Path(project) / "raw"
        raw.mkdir()
        (raw / "IMG_1001.CR3").write_bytes(b"complete-catch-source")
        plan = build_selection_plan(project, "图片选片", "视频选片", "raw", "", ["1001"])
        destination = Path(plan["files"][0]["destination"])
        original_native = catch.try_atomic_rename_no_replace
        original_copyfileobj = catch.shutil.copyfileobj
        original_unlink = catch.os.unlink
        marker_seen_during_copy = False
        def fail_mid_copy(input_file, output_file, _length):
            nonlocal marker_seen_during_copy
            marker_seen_during_copy = bool(list(destination.parent.glob(f".{destination.name}.photoflow-recovery-*.json")))
            output_file.write(input_file.read(6))
            output_file.flush()
            raise OSError("catch fallback copy interrupted")
        def refuse_cleanup(path):
            if Path(path) == destination:
                raise OSError("catch target cleanup unavailable")
            return original_unlink(path)
        catch.try_atomic_rename_no_replace = lambda _source, _destination: False
        catch.shutil.copyfileobj = fail_mid_copy
        catch.os.unlink = refuse_cleanup
        try:
            try:
                execute_plan(plan)
                raise AssertionError("expected failed copy transaction")
            except catch.CopyTransactionError as error:
                assert len(error.rollback_errors) == 1
                assert isinstance(error.cause, catch.PublishCleanupError)
                marker = Path(error.cause.recovery_marker)
                staging = Path(error.cause.source)
                assert staging.read_bytes() == b"complete-catch-source"
                assert destination.read_bytes() == b"comple"
                assert marker.is_file()
                assert marker_seen_during_copy
        finally:
            catch.try_atomic_rename_no_replace = original_native
            catch.shutil.copyfileobj = original_copyfileobj
            catch.os.unlink = original_unlink
        recovered_staging = Path(catch.recover_incomplete_publication(marker, marker.parent, marker.parent))
        assert recovered_staging.read_bytes() == b"complete-catch-source"
        assert recovered_staging == destination and not marker.exists()
        recovered_staging.unlink()

    # A real mid-copy hard exit must be auto-recovered by build_selection_plan
    # before destination existence is classified.
    with tempfile.TemporaryDirectory() as project:
        project_path = Path(project)
        raw = project_path / "raw"
        target_dir = project_path / "图片选片"
        raw.mkdir()
        target_dir.mkdir()
        source = raw / "IMG_1001.CR3"
        destination = target_dir / source.name
        source.write_bytes(b"complete-subprocess-catch-source")
        crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import catch
source, destination = sys.argv[2], sys.argv[3]
catch.try_atomic_rename_no_replace = lambda _source, _destination: False
def crash_mid_copy(input_file, output_file, _length):
    output_file.write(input_file.read(9))
    output_file.flush()
    os._exit(73)
catch.shutil.copyfileobj = crash_mid_copy
catch.copy_file_atomically(source, destination, None, lambda _count: None)
'''
        crashed = __import__("subprocess").run(
            [sys.executable, "-c", crash_script, ROOT, str(source), str(destination)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert crashed.returncode == 73
        assert destination.read_bytes() == b"complete-"[:9]
        assert list(target_dir.glob(f".{destination.name}.photoflow-recovery-*.json"))
        plan = build_selection_plan(project, "图片选片", "视频选片", "raw", "", ["1001"])
        assert plan["files"] == []
        assert [item["name"] for item in plan["existing"]] == ["IMG_1001.CR3"]
        assert destination.read_bytes() == source.read_bytes()
        assert not list(target_dir.glob(f".{destination.name}.photoflow-recovery-*.json"))

    # Exit after the complete staging has been unlinked but before committed is
    # recorded. The next plan build must finish the committing marker idempotently.
    with tempfile.TemporaryDirectory() as project:
        project_path = Path(project)
        raw = project_path / "raw"; raw.mkdir()
        target_dir = project_path / "图片选片"; target_dir.mkdir()
        source = raw / "IMG_2001.CR3"
        destination = target_dir / source.name
        source.write_bytes(b"catch-committing-window")
        crash_script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "python"))
import catch
catch.try_atomic_rename_no_replace = lambda _source, _destination: False
original_unlink = catch.os.unlink
def crash_after_staging_unlink(path):
    original_unlink(path)
    if ".photoflow-" in Path(path).name and Path(path).name.endswith(".part"):
        os._exit(77)
catch.os.unlink = crash_after_staging_unlink
catch.copy_file_atomically(sys.argv[2], sys.argv[3], None, lambda _count: None)
'''
        crashed = __import__("subprocess").run(
            [sys.executable, "-c", crash_script, ROOT, str(source), str(destination)],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        assert crashed.returncode == 77
        plan = build_selection_plan(project, "图片选片", "视频选片", "raw", "", ["2001"])
        assert [item["name"] for item in plan["existing"]] == [source.name]
        assert destination.read_bytes() == b"catch-committing-window"
        assert not list(target_dir.glob(".*.photoflow-recovery-*.json"))
        assert not list(target_dir.glob("*.photoflow-*.part"))

    output = ReconfigurableStringIO()
    original_build = catch.build_selection_plan
    original_execute = catch.execute_plan
    catch.build_selection_plan = lambda *_args, **_kwargs: {
        "project_dir": ".", "keywords": ["1001"], "matched_keywords": ["1001"], "missing": [],
        "existing": [], "conflicts": [], "files": [{"size": 1, "kind": "image"}], "signature": "sig",
    }
    catch.execute_plan = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        catch.CopyTransactionError(OSError("copy failed"), [("target", OSError("rollback failed"))])
    )
    try:
        with redirect_stdout(output):
            catch.run(["--source", ".", "--keywords", "1001", "--execute", "--expected_signature", "sig"])
    finally:
        catch.build_selection_plan = original_build
        catch.execute_plan = original_execute
    terminal_events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]
    assert terminal_events[-1]["type"] == "error"
    assert not any(event["type"] in {"partial", "success"} for event in terminal_events)

    print("Filename selection tests passed.")


if __name__ == "__main__":
    main()
