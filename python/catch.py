import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid

from event_protocol import emit, log_error, log_info, log_progress, log_success


IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff', '.heic', '.webp',
                    '.cr2', '.cr3', '.arw', '.nef', '.orf', '.rwl', '.dng', '.raf', '.3fr', '.fff'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi', '.m4v', '.mkv', '.mts', '.m2ts'}
COPY_CHUNK_SIZE = 8 * 1024 * 1024


class TaskCancelled(Exception):
    pass


def parse_search_names(text):
    """Extract selection keys without treating a camera filename prefix as a key."""
    search_names = []
    seen = set()
    for token in re.findall(r'[A-Za-z0-9_.]+', text):
        if token.isdigit():
            match = token if len(token) >= 3 else None
        else:
            trailing = re.search(r'(\d{3,})(?:\.[A-Za-z0-9]+)?$', token)
            match = trailing.group(1) if trailing else None
        if match and match not in seen:
            seen.add(match)
            search_names.append(match)
    return search_names


def filename_selection_key(filename):
    """Return the final numeric camera sequence, never a prefix such as 618 in 618A7394."""
    stem = os.path.splitext(filename)[0]
    match = re.search(r'(\d{3,})$', stem)
    return match.group(1) if match else None


def find_project_folder(project_dir, wanted_name):
    if not wanted_name or not os.path.isdir(project_dir):
        return None
    for entry in os.scandir(project_dir):
        if entry.is_dir() and entry.name.casefold() == wanted_name.casefold():
            return entry.path
    return None


def ensure_not_cancelled(cancel_file):
    if cancel_file and os.path.exists(cancel_file):
        raise TaskCancelled()


def scan_media(source_dir, extensions, cancel_file=None):
    """Scan a source tree once and index supported media by its final numeric sequence."""
    index = {}
    if not source_dir:
        return index
    for root, _, files in os.walk(source_dir):
        ensure_not_cancelled(cancel_file)
        for name in files:
            if os.path.splitext(name)[1].lower() not in extensions:
                continue
            key = filename_selection_key(name)
            if not key:
                continue
            path = os.path.join(root, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            index.setdefault(key, []).append({"source": path, "name": name, "size": size})
    return index


def summarize_plan(plan):
    return {
        "keywordCount": len(plan["keywords"]),
        "matchedKeywordCount": len(plan["matched_keywords"]),
        "filesToCopy": len(plan["files"]),
        "totalBytes": sum(item["size"] for item in plan["files"]),
        "imageCount": sum(item["kind"] == "image" for item in plan["files"]),
        "videoCount": sum(item["kind"] == "video" for item in plan["files"]),
        "existingCount": len(plan["existing"]),
        "conflictCount": len(plan["conflicts"]),
        "missingKeywords": plan["missing"],
        "existingNames": [item["name"] for item in plan["existing"][:20]],
        "conflictNames": plan["conflicts"][:20],
        "signature": plan["signature"],
    }


def build_selection_plan(project_dir, image_dest_name, video_dest_name, image_source_name,
                         video_source_name, search_names, cancel_file=None):
    project_dir = os.path.abspath(project_dir)
    raw_dir = find_project_folder(project_dir, image_source_name)
    mov_dir = find_project_folder(project_dir, video_source_name)
    if not raw_dir and not mov_dir:
        raise FileNotFoundError("项目中没有找到配置的图片或视频来源文件夹。")

    image_index = scan_media(raw_dir, IMAGE_EXTENSIONS, cancel_file)
    video_index = scan_media(mov_dir, VIDEO_EXTENSIONS, cancel_file)
    image_target = os.path.join(project_dir, image_dest_name)
    video_target = os.path.join(project_dir, video_dest_name)
    candidates = []
    matched_keywords = []
    missing = []

    for keyword in search_names:
        ensure_not_cancelled(cancel_file)
        matches = image_index.get(keyword, [])
        kind = "image"
        target_dir = image_target
        if not matches:
            matches = video_index.get(keyword, [])
            kind = "video"
            target_dir = video_target
        if not matches:
            missing.append(keyword)
            continue
        matched_keywords.append(keyword)
        for match in matches:
            candidates.append({
                **match,
                "kind": kind,
                "destination": os.path.join(target_dir, match["name"]),
            })

    # One source can be found by only one exact key, but keep this guard for future parser changes.
    unique_sources = {}
    for item in candidates:
        unique_sources.setdefault(os.path.normcase(os.path.abspath(item["source"])), item)
    candidates = list(unique_sources.values())

    destination_groups = {}
    for item in candidates:
        destination_groups.setdefault(os.path.normcase(item["destination"]), []).append(item)

    conflicts = []
    existing = []
    files = []
    for group in destination_groups.values():
        if len(group) > 1:
            conflicts.append(group[0]["name"])
            continue
        item = group[0]
        if os.path.exists(item["destination"]):
            existing.append(item)
        else:
            files.append(item)

    signature_payload = [{
        "source": os.path.normcase(os.path.abspath(item["source"])),
        "destination": os.path.normcase(os.path.abspath(item["destination"])),
        "size": item["size"],
        "mtime": os.path.getmtime(item["source"]),
    } for item in sorted(files, key=lambda value: os.path.normcase(value["source"]))]
    signature = hashlib.sha256(json.dumps(signature_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return {
        "project_dir": project_dir,
        "keywords": search_names,
        "matched_keywords": matched_keywords,
        "missing": missing,
        "existing": existing,
        "conflicts": conflicts,
        "files": files,
        "signature": signature,
    }


def copy_file_atomically(source, destination, cancel_file, on_bytes):
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    temporary = os.path.join(
        os.path.dirname(destination),
        f".{os.path.basename(destination)}.photoflow-{uuid.uuid4().hex}.part",
    )
    try:
        with open(source, "rb") as source_file, open(temporary, "xb") as target_file:
            while True:
                ensure_not_cancelled(cancel_file)
                chunk = source_file.read(COPY_CHUNK_SIZE)
                if not chunk:
                    break
                target_file.write(chunk)
                on_bytes(len(chunk))
            target_file.flush()
            os.fsync(target_file.fileno())
        shutil.copystat(source, temporary)
        ensure_not_cancelled(cancel_file)
        if os.path.exists(destination):
            raise FileExistsError(f"目标中已出现同名文件：{os.path.basename(destination)}")
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            try:
                os.remove(temporary)
            except OSError:
                pass


def execute_plan(plan, cancel_file=None):
    files = plan["files"]
    total_bytes = sum(item["size"] for item in files)
    if total_bytes:
        free_bytes = shutil.disk_usage(plan["project_dir"]).free
        if free_bytes < total_bytes:
            raise OSError(f"目标磁盘空间不足：还需要 {total_bytes - free_bytes} 字节。")

    created = []
    copied_bytes = 0
    last_progress_at = 0.0
    current_file_name = ""
    current_file_index = 0

    def report_bytes(byte_count):
        nonlocal copied_bytes, last_progress_at
        copied_bytes += byte_count
        now = time.monotonic()
        if now - last_progress_at >= 0.25 or copied_bytes >= total_bytes:
            percent = 100 if total_bytes == 0 else min(99, round(copied_bytes * 100 / total_bytes))
            log_progress(f"正在复制：{current_file_name}（{current_file_index}/{len(files)}）", percent, {
                "bytesCopied": copied_bytes,
                "totalBytes": total_bytes,
                "fileName": current_file_name,
                "fileIndex": current_file_index,
                "totalFiles": len(files),
            })
            last_progress_at = now

    try:
        ensure_not_cancelled(cancel_file)
        for index, item in enumerate(files, start=1):
            current_file_name = item["name"]
            current_file_index = index
            percent = 0 if total_bytes == 0 else min(99, round(copied_bytes * 100 / total_bytes))
            log_progress(f"正在复制：{current_file_name}（{current_file_index}/{len(files)}）", percent, {
                "bytesCopied": copied_bytes,
                "totalBytes": total_bytes,
                "fileName": current_file_name,
                "fileIndex": current_file_index,
                "totalFiles": len(files),
                "fileStarted": True,
            })
            copy_file_atomically(item["source"], item["destination"], cancel_file, report_bytes)
            created.append(item["destination"])
            ensure_not_cancelled(cancel_file)
        ensure_not_cancelled(cancel_file)
        return len(created)
    except BaseException:
        # Only remove outputs created by this run. Pre-existing files are never overwritten.
        for destination in reversed(created):
            try:
                os.remove(destination)
            except OSError:
                pass
        raise


def run(arguments):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="项目文件夹路径")
    parser.add_argument("--keywords", nargs='+', required=True, help="包含文件名的混合文本")
    parser.add_argument("--image_dest_name", default="图片选片")
    parser.add_argument("--video_dest_name", default="视频选片")
    parser.add_argument("--image_source_name", default="raw")
    parser.add_argument("--video_source_name", default="mov")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--expected_signature", default="")
    parser.add_argument("--cancel_file", default="")
    args = parser.parse_args(arguments)

    project_dir = args.source.strip().strip('"').strip("'")
    search_names = parse_search_names(" ".join(args.keywords))
    if not search_names:
        log_error("未从输入内容中提取到可用的文件编号（至少 3 位数字）。")
        return

    try:
        log_info("正在扫描来源文件夹并生成选片计划……")
        plan = build_selection_plan(
            project_dir, args.image_dest_name, args.video_dest_name,
            args.image_source_name, args.video_source_name, search_names, args.cancel_file,
        )
        summary = summarize_plan(plan)
        if not args.execute:
            emit("preview", "选片计划已生成", data=summary)
            return
        if not args.expected_signature or args.expected_signature != plan["signature"]:
            log_error("来源或目标文件在确认后发生了变化，请重新预检。")
            return
        if not plan["files"]:
            log_success("没有需要复制的新文件。", data=summary)
            return
        log_info(f"开始复制 {len(plan['files'])} 个媒体文件。")
        copied = execute_plan(plan, args.cancel_file)
        log_progress("复制完成", 100, {"bytesCopied": summary["totalBytes"], "totalBytes": summary["totalBytes"]})
        log_success(f"选片完成，共复制 {copied} 个文件。", data=summary)
    except TaskCancelled:
        emit("cancelled", "任务已取消，已回滚本次复制的文件。")
    except Exception as error:
        log_error(f"选片失败，已回滚本次复制的文件：{error}")


if __name__ == "__main__":
    run(sys.argv[1:])
