"""Extract images embedded in Microsoft Office Open XML documents."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath


WORD_EXTENSIONS = {".docx", ".docm", ".dotx", ".dotm"}
POWERPOINT_EXTENSIONS = {".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppam"}
EXCEL_EXTENSIONS = {".xlsx", ".xlsm", ".xltx", ".xltm", ".xlam", ".xlsb"}
IMAGE_EXTENSIONS = {
    ".avif", ".bmp", ".emf", ".gif", ".heic", ".heif", ".hif", ".ico",
    ".jfif", ".jpe", ".jpeg", ".jpg", ".png", ".svg", ".tif",
    ".tiff", ".webp", ".wmf",
}
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def media_root_for(document: Path) -> str | None:
    extension = document.suffix.lower()
    if extension in WORD_EXTENSIONS:
        return "word"
    if extension in POWERPOINT_EXTENSIONS:
        return "ppt"
    if extension in EXCEL_EXTENSIONS:
        return "xl"
    return None


def safe_name(value: str, fallback: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).rstrip(". ") or fallback
    if Path(name).stem.upper() in WINDOWS_RESERVED_NAMES:
        name = f"_{name}"
    return name[:180]


def create_unique_directory(parent: Path, preferred_name: str) -> Path:
    base_name = safe_name(preferred_name, "文档_media")
    for index in range(1, 10000):
        candidate = parent / (base_name if index == 1 else f"{base_name}_{index}")
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError("无法创建唯一的图片输出文件夹")


def unique_file_path(directory: Path, file_name: str) -> Path:
    safe_file_name = safe_name(file_name, "image")
    candidate = directory / safe_file_name
    if not candidate.exists():
        return candidate
    stem = Path(safe_file_name).stem
    suffix = Path(safe_file_name).suffix
    for index in range(2, 10000):
        candidate = directory / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"无法为图片生成唯一名称：{safe_file_name}")


def image_members(archive: zipfile.ZipFile, media_root: str) -> list[zipfile.ZipInfo]:
    prefix = f"{media_root}/media/"
    members: list[zipfile.ZipInfo] = []
    for member in archive.infolist():
        normalized = member.filename.replace("\\", "/")
        pure_path = PurePosixPath(normalized)
        if member.is_dir() or not normalized.lower().startswith(prefix):
            continue
        if len(pure_path.parts) != 3 or pure_path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        members.append(member)
    return members


def extract_document(document_path: str, max_files: int = 2000, max_bytes: int = 2 * 1024 * 1024 * 1024) -> dict[str, object]:
    document = Path(document_path).resolve()
    result: dict[str, object] = {
        "document": str(document),
        "documentName": document.name,
        "success": False,
        "count": 0,
    }
    output_directory: Path | None = None
    try:
        if not document.is_file():
            raise ValueError("文档不存在")
        media_root = media_root_for(document)
        if not media_root:
            raise ValueError("不支持此 Office 文件格式")
        if not zipfile.is_zipfile(document):
            raise ValueError("文档不是有效的 Office Open XML 文件")

        with zipfile.ZipFile(document, "r") as archive:
            members = image_members(archive, media_root)
            if len(members) > max_files or sum(max(0, int(member.file_size)) for member in members) > max_bytes:
                raise ValueError("文档内图片数量或总大小超过安全上限")
            if not members:
                result.update(success=True, message="文档中没有图片")
                return result
            output_directory = create_unique_directory(document.parent, f"{document.stem}_media")
            extracted_files: list[str] = []
            total_bytes = 0
            for member in members:
                output_path = unique_file_path(output_directory, PurePosixPath(member.filename).name)
                with archive.open(member, "r") as source, output_path.open("xb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                extracted_files.append(str(output_path))
                total_bytes += output_path.stat().st_size
                if total_bytes > max_bytes:
                    raise ValueError("文档内图片总大小超过安全上限")

        result.update(
            success=True,
            count=len(extracted_files),
            totalBytes=total_bytes,
            outputFolder=str(output_directory),
            files=extracted_files,
        )
        return result
    except Exception as error:
        if output_directory and output_directory.exists():
            shutil.rmtree(output_directory, ignore_errors=True)
        result["error"] = str(error)
        return result


def run(args_list: list[str]) -> None:
    parser = argparse.ArgumentParser(description="提取 Office Open XML 文档中的图片")
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--input", action="append", required=True, dest="inputs")
    extract_parser.add_argument("--max-files", type=int, default=2000)
    extract_parser.add_argument("--max-bytes", type=int, default=2 * 1024 * 1024 * 1024)
    args = parser.parse_args(args_list)

    if args.max_files < 1 or args.max_files > 2000 or args.max_bytes < 1 or args.max_bytes > 2 * 1024 * 1024 * 1024:
        raise ValueError("Office 图片提取安全上限无效")
    results = [extract_document(document, args.max_files, args.max_bytes) for document in args.inputs]
    successful = [result for result in results if result.get("success")]
    failed = [result for result in results if not result.get("success")]
    payload = {
        "success": bool(successful) or not failed,
        "documentCount": len(results),
        "successfulCount": len(successful),
        "failedCount": len(failed),
        "imageCount": sum(int(result.get("count", 0)) for result in successful),
        "results": results,
    }
    if failed and not successful:
        payload["error"] = str(failed[0].get("error") or "提取图片失败")
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    import sys
    run(sys.argv[1:])
