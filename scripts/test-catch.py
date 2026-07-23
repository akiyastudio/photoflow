import os
import sys
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))

import catch
from catch import TaskCancelled, build_selection_plan, execute_plan, filename_selection_key, parse_search_names


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

    print("Filename selection tests passed.")


if __name__ == "__main__":
    main()
