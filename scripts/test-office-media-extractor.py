import importlib.util
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "components" / "office-media-extractor" / "office_media_extractor.py"
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

print("Office media extractor tests passed")
