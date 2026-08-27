import importlib.util
import json
import subprocess
import sys
import tempfile
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

print("Office media extractor tests passed")
