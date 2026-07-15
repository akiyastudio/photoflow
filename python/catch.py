import argparse
import json
import os
import re
import shutil
import sys

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff', '.heic', '.webp',
                    '.cr2', '.cr3', '.arw', '.nef', '.orf', '.rwl', '.dng', '.raf', '.3fr', '.fff'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi', '.m4v', '.mkv', '.mts', '.m2ts'}


def emit(event_type, message, data=None, progress=None):
    payload = {"type": event_type, "message": message}
    if data is not None:
        payload["data"] = data
    if progress is not None:
        payload["progress"] = progress
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def log_info(message):
    emit('log', message)


def log_success(message):
    emit('success', message)


def log_error(message):
    emit('error', message)


def find_project_folder(project_dir, wanted_name):
    if not os.path.isdir(project_dir):
        return None
    for entry in os.scandir(project_dir):
        if entry.is_dir() and entry.name.casefold() == wanted_name.casefold():
            return entry.path
    return None


def matching_files(source_dir, keyword):
    if not source_dir:
        return []
    matches = []
    for root, _, files in os.walk(source_dir):
        matches.extend(os.path.join(root, name) for name in files if keyword in name)
    return matches


def process_project(project_dir, image_dest_name, video_dest_name, search_names):
    project_dir = os.path.abspath(project_dir)
    raw_dir = find_project_folder(project_dir, 'RAW')
    mov_dir = find_project_folder(project_dir, 'MOV')
    if not raw_dir and not mov_dir:
        log_error("项目中没有找到 RAW 或 MOV 文件夹。")
        return

    image_target = os.path.join(project_dir, image_dest_name)
    video_target = os.path.join(project_dir, video_dest_name)
    copied, skipped, missing = 0, 0, []
    log_info("开始选片：优先在 RAW 中查找，未命中的文件名再到 MOV 中查找。")

    for keyword in search_names:
        matches = matching_files(raw_dir, keyword)
        source_label = 'RAW'
        if not matches:
            matches = matching_files(mov_dir, keyword)
            source_label = 'MOV'
        if not matches:
            missing.append(keyword)
            continue

        log_info(f"{keyword}: 在 {source_label} 中找到 {len(matches)} 个匹配文件")
        for source_path in matches:
            extension = os.path.splitext(source_path)[1].lower()
            target_dir = video_target if extension in VIDEO_EXTENSIONS else image_target
            os.makedirs(target_dir, exist_ok=True)
            destination = os.path.join(target_dir, os.path.basename(source_path))
            if os.path.exists(destination):
                skipped += 1
                log_info(f"跳过同名文件: {os.path.basename(source_path)}")
                continue
            try:
                shutil.copy2(source_path, destination)
                copied += 1
                log_info(f"复制到 {os.path.basename(target_dir)}: {os.path.basename(source_path)}")
            except Exception as error:
                log_error(f"复制失败 {os.path.basename(source_path)}: {error}")

    if missing:
        log_info(f"以下文件名在 RAW 和 MOV 中均未找到: {', '.join(missing)}")
    if copied == 0 and skipped == 0:
        log_error("未找到任何包含指定文件名的文件。")
        return

    message = f"选片完成。成功复制 {copied} 个文件"
    if skipped:
        message += f"，跳过 {skipped} 个同名文件"
    if missing:
        message += f"，{len(missing)} 个文件名未命中"
    log_success(message)


def run(arguments):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="项目文件夹路径")
    parser.add_argument("--keywords", nargs='+', required=True, help="包含数字的混合文本")
    parser.add_argument("--image_dest_name", default="图片选片")
    parser.add_argument("--video_dest_name", default="视频选片")
    args = parser.parse_args(arguments)

    project_dir = args.source.strip().strip('"').strip("'")
    search_names = list(dict.fromkeys(re.findall(r'\d{3,}', " ".join(args.keywords))))
    if not search_names:
        log_error("未从输入内容中提取到任何数字作为文件名。")
        return
    process_project(project_dir, args.image_dest_name, args.video_dest_name, search_names)


if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as error:
        log_error(f"脚本运行出错: {error}")
