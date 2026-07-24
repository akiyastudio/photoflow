import sys
import os
import shutil
import time
import datetime
import argparse
import subprocess
import re
import json
from pathlib import Path
import gc
from event_protocol import ask_user, log_error, log_info, log_progress, log_status, log_success
from ffmpeg_utils import get_ffmpeg_exe

# --- 2. 辅助工具函数 ---
def safe_chunk_copy(src, dst, chunk_size=4 * 1024 * 1024, on_progress=None):
    bytes_copied = 0
    try:
        with open(src, 'rb') as fsrc, open(dst, 'wb') as fdst:
            while True:
                buf = fsrc.read(chunk_size)
                if not buf:
                    break
                fdst.write(buf)
                bytes_copied += len(buf)
                if on_progress:
                    on_progress(bytes_copied)
                # 防止读卡器性能太差崩盘
                time.sleep(0.002) 
        
        shutil.copystat(src, dst)
    except Exception as e:
        # 如果中途出错（比如读卡器突然拔出），with open 会确保文件句柄被立即强制关闭
        # 避免 Windows 内核锁死
        raise e

def get_file_time(file_path):
    try: return os.path.getmtime(file_path)
    except: return 0

VALID_MEDIA_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.heic', '.mp4', '.mov', '.avi', '.crm', '.rwl', '.raf', '.3fr', '.fff')

def scan_sd_media(sd_path):
    normalized_sd = os.path.normpath(sd_path)
    base_sd = os.path.dirname(normalized_sd) if normalized_sd.upper().endswith('DCIM') else normalized_sd
    files = []
    for target_dir in (os.path.join(base_sd, 'DCIM'), os.path.join(base_sd, 'PRIVATE')):
        if not os.path.exists(target_dir):
            continue
        for root, dirs, names in os.walk(target_dir):
            dirs[:] = [directory for directory in dirs if not directory.startswith('.')]
            files.extend(
                os.path.join(root, name)
                for name in names
                if not name.startswith('.') and name.lower().endswith(VALID_MEDIA_EXTENSIONS)
            )
    return base_sd, files

def build_capture_groups(files, split_threshold_hours=2.0):
    """Group each capture day, additionally splitting at a clear time gap."""
    days = {}
    for file_path in files:
        timestamp = get_file_time(file_path)
        date_key = datetime.datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
        days.setdefault(date_key, []).append((file_path, timestamp))
    groups = []
    for date_key in sorted(days):
        ordered = sorted(days[date_key], key=lambda item: item[1])
        day_groups = [[ordered[0]]]
        for item in ordered[1:]:
            if (item[1] - day_groups[-1][-1][1]) / 3600.0 > split_threshold_hours:
                day_groups.append([item])
            else:
                day_groups[-1].append(item)
        for index, group in enumerate(day_groups, start=1):
            groups.append({
                'id': f'{date_key}:{index}',
                'date': date_key,
                'index': index,
                'files': group,
                'count': len(group),
                'startTime': datetime.datetime.fromtimestamp(group[0][1]).strftime('%H:%M'),
                'endTime': datetime.datetime.fromtimestamp(group[-1][1]).strftime('%H:%M'),
            })
    return groups

def stage_plan_import(sd_path, projects_json, import_type='work', split_threshold_hours=2.0):
    base_sd, files = scan_sd_media(sd_path)
    if not files:
        log_error(f"在 {base_sd} 的 DCIM/PRIVATE 目录下没有找到媒体文件")
        return
    try:
        projects = json.loads(projects_json or '[]')
    except (TypeError, ValueError, json.JSONDecodeError):
        projects = []
    groups = build_capture_groups(files, split_threshold_hours)
    payload_groups = []
    automatic_routes = {}
    requires_choice = False
    for group in groups:
        year, month, day = (int(part) for part in group['date'].split('-'))
        exact = [project for project in projects if project.get('projectDate', {}).get('year') == year and project.get('projectDate', {}).get('month') == month and project.get('projectDate', {}).get('day') == day]
        month_only = [project for project in projects if project.get('projectDate', {}).get('year') == year and project.get('projectDate', {}).get('month') == month and not project.get('projectDate', {}).get('day')]
        if len(exact) == 1:
            automatic_routes[group['id']] = exact[0].get('path', '')
        else:
            requires_choice = True
        payload_groups.append({
            key: group[key] for key in ('id', 'date', 'index', 'count', 'startTime', 'endTime')
        } | {
            'exactProjectPaths': [project.get('path', '') for project in exact],
            'suggestedProjectPaths': [project.get('path', '') for project in (exact or month_only)],
        })
    ask_user(
        '检测到需要确认的项目归属' if requires_choice else '已按项目拍摄日期确定导入位置',
        {
            'kind': 'project_routing',
            'importType': import_type,
            'requiresChoice': requires_choice,
            'groups': payload_groups,
            'automaticRoutes': automatic_routes,
        },
    )

def unique_destination(directory, file_name):
    """Never overwrite an earlier card import or another folder's same name."""
    destination = os.path.join(directory, file_name)
    if not os.path.exists(destination):
        return destination
    stem, extension = os.path.splitext(file_name)
    index = 1
    while True:
        candidate = os.path.join(directory, f"{stem} ({index}){extension}")
        if not os.path.exists(candidate):
            return candidate
        index += 1

def classify_files_by_type(folder_path):
    """整理子文件夹"""
    ext_map = {
        'jpg': ('.jpg', '.jpeg', '.hif', '.heic'),
        'raw': ('.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.rwl', '.raf', '.3fr', '.fff'),
        'mov': ('.mp4', '.mov', '.avi', '.crm')
    }
    for f in os.listdir(folder_path):
        src_path = os.path.join(folder_path, f)
        if not os.path.isfile(src_path) or f.startswith('.'): continue
        f_lower = f.lower()
        for sub, exts in ext_map.items():
            if f_lower.endswith(exts):
                sub_dir = os.path.join(folder_path, sub)
                os.makedirs(sub_dir, exist_ok=True)
                # 如果子目录已有同名文件，加时间戳
                dst_path = unique_destination(sub_dir, f)
                shutil.move(src_path, dst_path)
                break

def generate_video_previews(target_folder):
    """Create H.264 MP4 previews for the already classified video files."""
    source_dir = os.path.join(target_folder, 'mov')
    if not os.path.isdir(source_dir):
        return 0, 0

    video_extensions = ('.mp4', '.mov', '.avi', '.crm')
    video_files = [
        name for name in os.listdir(source_dir)
        if os.path.isfile(os.path.join(source_dir, name)) and name.lower().endswith(video_extensions)
    ]
    if not video_files:
        return 0, 0

    output_dir = os.path.join(target_folder, 'mov_预览')
    os.makedirs(output_dir, exist_ok=True)
    ffmpeg_exe = get_ffmpeg_exe()
    succeeded = 0

    log_info(f"正在生成 {len(video_files)} 个视频预览版...")
    for index, file_name in enumerate(video_files, start=1):
        input_path = os.path.join(source_dir, file_name)
        output_name = f"{Path(file_name).stem}.mp4"
        output_path = os.path.join(output_dir, output_name)
        if os.path.exists(output_path):
            output_path = os.path.join(output_dir, f"{Path(file_name).stem}_{int(time.time())}.mp4")

        command = [
            ffmpeg_exe, '-y', '-i', input_path,
            '-map', '0:v:0', '-map', '0:a?',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p',
            '-c:v', 'libx264', '-preset', 'medium',
            '-b:v', '4M', '-maxrate', '5M', '-bufsize', '8M',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart', output_path
        ]
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
        if result.returncode == 0:
            succeeded += 1
            log_info(f"视频预览版 {index}/{len(video_files)}：{os.path.basename(output_path)}")
        else:
            detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else '未知转码错误'
            emit('warning', f"视频预览生成失败，已保留原视频 {file_name}：{detail}")

    return succeeded, len(video_files)

def split_large_videos(target_folder):
    """Losslessly split imported videos for FAT32 and cloud single-file limits."""
    source_dir = os.path.join(target_folder, 'mov')
    if not os.path.isdir(source_dir):
        return 0

    target_size = 3.95 * 1024 * 1024 * 1024
    ffmpeg_exe = get_ffmpeg_exe()
    split_count = 0
    for file_name in list(os.listdir(source_dir)):
        input_path = os.path.join(source_dir, file_name)
        if not os.path.isfile(input_path) or os.path.getsize(input_path) <= target_size:
            continue

        probe = subprocess.run([ffmpeg_exe, '-i', input_path], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
        match = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', probe.stderr)
        if not match:
            emit('warning', f'无法读取视频时长，未分割：{file_name}')
            continue

        hours, minutes, seconds = match.groups()
        total_seconds = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        segment_duration = total_seconds * (target_size / os.path.getsize(input_path))
        stem, extension = os.path.splitext(input_path)
        output_pattern = f'{stem}_part%03d{extension}'
        log_info(f'正在将超过 4GB 的视频分割为约 3.95GB：{file_name}')
        result = subprocess.run([
            ffmpeg_exe, '-y', '-i', input_path, '-c', 'copy', '-f', 'segment',
            '-segment_time', str(segment_duration), '-reset_timestamps', '1', output_pattern
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
        prefix = os.path.basename(stem) + '_part'
        segments = [name for name in os.listdir(source_dir) if name.startswith(prefix) and name.lower().endswith(extension.lower())]
        if result.returncode == 0 and len(segments) >= 2:
            os.remove(input_path)
            split_count += 1
            log_info(f'视频分割完成：{file_name} → {len(segments)} 段')
        else:
            for segment in segments:
                try: os.remove(os.path.join(source_dir, segment))
                except OSError: pass
            detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else '未生成完整分段'
            emit('warning', f'视频分割失败，已保留原文件 {file_name}：{detail}')
    return split_count
# --- 3. 核心导入流程 ---
def stage_import_and_organize(sd_path, dest_path, backup_path=None, split_threshold_hours=2.0, should_split=None, generate_video_preview=False, split_large_files=False, project_routes=None, direct_project=False):
    # 临时存放区（即使出错也保留，直到确认安全）
    temp_dir = os.path.join(dest_path, "_PhotoFlow_Safety_Temp")
    
    # 记录原始文件列表，用于最后的清理
    original_sd_files = []
    success_imported_count = 0
    created_projects = []

    try:
        time.sleep(2.5)
        # Step 1: 扫描 SD 卡 (仅扫描 DCIM 和 PRIVATE 目录)
        base_sd, original_sd_files = scan_sd_media(sd_path)
        
        if not original_sd_files:
            log_error(f"在 {base_sd} 的 DCIM/PRIVATE 目录下没有找到媒体文件")
            return

        total_bytes = sum(os.path.getsize(file_path) for file_path in original_sd_files)


# Step 2: 复制到临时区 (仅复制不存在或不完整的文件)
        os.makedirs(temp_dir, exist_ok=True)
        log_info(f"正在处理 {len(original_sd_files)} 个文件...")
        
        temp_files_list = []
        completed_bytes = 0
        transferred_bytes = 0
        transfer_started_at = time.monotonic()
        last_progress_at = 0.0

        def publish_transfer_progress(filename, current_file_bytes, files_copied):
            nonlocal last_progress_at
            now = time.monotonic()
            bytes_copied = min(total_bytes, completed_bytes + current_file_bytes)
            if now - last_progress_at < 0.1 and bytes_copied < total_bytes:
                return
            last_progress_at = now
            elapsed = max(0.001, now - transfer_started_at)
            log_progress(
                f"导入中: {filename}",
                int((bytes_copied / max(1, total_bytes)) * 100),
                {
                    "bytesCopied": bytes_copied,
                    "totalBytes": total_bytes,
                    "bytesPerSecond": (transferred_bytes + current_file_bytes) / elapsed,
                    "filesCopied": files_copied,
                    "totalFiles": len(original_sd_files),
                },
            )

        for idx, src in enumerate(original_sd_files):
            filename = os.path.basename(src)
            dst = os.path.join(temp_dir, filename)
            source_size = os.path.getsize(src)
            time.sleep(0.005)
            
            # 如果临时目录已存在该文件，且大小与原文件一致，则跳过复制
            if os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(src):
                temp_files_list.append(dst)
                completed_bytes += source_size
                publish_transfer_progress(filename, 0, idx + 1)
                continue
            
            # 如果文件名冲突（即临时文件夹有同名文件但大小不同，通常是不同目录下的同名文件）
            if os.path.exists(dst):
                name, ext = os.path.splitext(filename)
                dst = os.path.join(temp_dir, f"{name}_{int(time.time()*1000)}{ext}")
            
            # 执行复制
            try:
                safe_chunk_copy(src, dst, on_progress=lambda current_bytes: publish_transfer_progress(filename, current_bytes, idx))
            except Exception as e:
                log_error(f"复制文件 {filename} 时读卡器断开或报错: {e}")
                # 如果复制单个文件就报错了，极大概率是读卡器已经掉线，抛出异常让外层统一处理
                raise e 
            
            temp_files_list.append(dst)
            completed_bytes += source_size
            transferred_bytes += source_size
            publish_transfer_progress(filename, 0, idx + 1)

        # Step 3: 分组逻辑处理
        files_with_time = [(f, get_file_time(f)) for f in temp_files_list]
        files_with_time.sort(key=lambda x: x[1])

        route_map = project_routes or {}
        # 检查是否需要分组提示（新项目日期路由已经在复制前确认，无需再次询问）
        need_split_check = False
        if len(files_with_time) > 1:
            for i in range(1, len(files_with_time)):
                if (files_with_time[i][1] - files_with_time[i-1][1]) / 3600.0 > split_threshold_hours:
                    need_split_check = True
                    break
        
        if not route_map and not direct_project and need_split_check and should_split is None:
            ask_user("检测到长时间拍摄间隔，是否分文件夹整理？", {"need_split": True, "files_count": len(temp_files_list)})
            return

        # Step 4: 移动到最终目的地并分类
        groups = []
        if route_map:
            groups = build_capture_groups([item[0] for item in files_with_time], split_threshold_hours)
        elif direct_project:
            groups = [{'id': 'direct', 'files': files_with_time}]
        elif should_split and need_split_check:
            current_group = [files_with_time[0]]
            for i in range(1, len(files_with_time)):
                if (files_with_time[i][1] - files_with_time[i-1][1]) / 3600.0 > split_threshold_hours:
                    groups.append(current_group)
                    current_group = [files_with_time[i]]
                else:
                    current_group.append(files_with_time[i])
            groups.append(current_group)
        else:
            groups = [files_with_time]

        log_info(f"正在整理到目标文件夹...")
        processed_targets = set()
        for idx, group_record in enumerate(groups):
            group = group_record['files'] if isinstance(group_record, dict) else group_record
            # 命名文件夹
            first_time = group[0][1]
            date_str = datetime.datetime.fromtimestamp(first_time).strftime('%m-%d').lstrip('0').replace('-0', '-')
            if len(groups) > 1:
                date_str = f"{date_str}-{idx+1}"
            if route_map:
                target_folder = os.path.abspath(route_map.get(group_record['id'], ''))
                if not target_folder or os.path.commonpath((os.path.abspath(dest_path), target_folder)) != os.path.abspath(dest_path) or not os.path.isdir(target_folder):
                    raise ValueError(f"分组 {group_record['id']} 的目标项目无效，请重新选择")
                date_str = os.path.basename(target_folder)
            elif direct_project:
                target_folder = os.path.abspath(dest_path)
                date_str = os.path.basename(target_folder)
            else:
                target_folder = os.path.join(dest_path, date_str)
            os.makedirs(target_folder, exist_ok=True)
            if date_str not in created_projects:
                created_projects.append(date_str)
            
            for f_path, _ in group:
                shutil.move(f_path, unique_destination(target_folder, os.path.basename(f_path)))
                success_imported_count += 1
            
            classify_files_by_type(target_folder)
            processed_targets.add(target_folder)

            # 备份
            if backup_path and os.path.exists(backup_path):
                backup_dst = os.path.join(backup_path, date_str)
                if os.path.exists(backup_dst): shutil.rmtree(backup_dst)
                shutil.copytree(target_folder, backup_dst)

        for target_folder in processed_targets:
            if split_large_files:
                split_count = split_large_videos(target_folder)
                if split_count:
                    log_info(f'大文件分割完成：共处理 {split_count} 个视频')
            if generate_video_preview:
                preview_count, video_count = generate_video_previews(target_folder)
                if video_count:
                    log_info(f"视频预览完成：{preview_count}/{video_count} 个文件已保存到 mov_预览")
        # Step 5: 最终校验与清理 SD 卡
        if success_imported_count == len(original_sd_files):
            log_info(f"整理完成，共处理 {success_imported_count} 个文件")
            
            # 只有在此刻，才开始清理 SD 卡
            log_info("正在安全清理 SD 卡原始文件...")
            for f in original_sd_files:
                try:
                    os.remove(f)
                except:
                    pass
            log_success("SD 卡清理完成", {"projectNames": created_projects, "importedCount": success_imported_count})
            
            # 只有全部成功，才清理临时目录
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)
        else:
            log_error(f"警告：导入数量不匹配（应有{len(original_sd_files)}，实际{success_imported_count}）。SD 卡未清理，请检查桌面临时文件夹。")

    except Exception as e:
        log_error(f"流程异常: {str(e)}")
        # 异常情况下保留临时文件夹和 SD 卡文件，确保数据不丢
        gc.collect()

def stage_import_broll(sd_path, dest_path, project_routes=None):
    """Copy card media into an explicitly selected project, grouped by media date."""
    base_sd, original_files = scan_sd_media(sd_path)
    created_files = []
    created_date_folders = []
    source_cleanup_started = False

    try:
        if not original_files:
            log_error(f"在 {base_sd} 的 DCIM/PRIVATE 目录下没有找到媒体文件")
            return

        if not dest_path or not os.path.isdir(dest_path):
            log_error("花絮目标项目不存在，请重新选择项目")
            return
        route_map = project_routes or {}
        file_routes = {}
        if route_map:
            for group in build_capture_groups(original_files):
                project_path = os.path.abspath(route_map.get(group['id'], ''))
                if not project_path or os.path.commonpath((os.path.abspath(dest_path), project_path)) != os.path.abspath(dest_path) or not os.path.isdir(project_path):
                    raise ValueError(f"分组 {group['id']} 的目标项目无效，请重新选择")
                for file_path, _timestamp in group['files']:
                    file_routes[file_path] = project_path
        total_bytes = sum(os.path.getsize(file_path) for file_path in original_files)
        completed_bytes = 0
        transfer_started_at = time.monotonic()
        last_progress_at = 0.0
        log_info(f"正在把 {len(original_files)} 个文件导入花絮...")
        for index, source in enumerate(original_files):
            media_time = datetime.datetime.fromtimestamp(get_file_time(source))
            date_name = media_time.strftime('%m-%d').lstrip('0').replace('-0', '-')
            project_path = file_routes.get(source, dest_path)
            broll_folder = os.path.join(project_path, '花絮')
            os.makedirs(broll_folder, exist_ok=True)
            date_folder = os.path.join(broll_folder, date_name)
            if not os.path.isdir(date_folder):
                os.makedirs(date_folder, exist_ok=False)
                created_date_folders.append(date_folder)
            destination = unique_destination(date_folder, os.path.basename(source))
            source_size = os.path.getsize(source)

            def publish_broll_progress(current_file_bytes, force=False):
                nonlocal last_progress_at
                now = time.monotonic()
                bytes_copied = min(total_bytes, completed_bytes + current_file_bytes)
                if not force and now - last_progress_at < 0.1 and bytes_copied < total_bytes:
                    return
                last_progress_at = now
                elapsed = max(0.001, now - transfer_started_at)
                log_progress(
                    f"导入花絮：{os.path.basename(source)}",
                    int((bytes_copied / max(1, total_bytes)) * 100),
                    {
                        "bytesCopied": bytes_copied,
                        "totalBytes": total_bytes,
                        "bytesPerSecond": bytes_copied / elapsed,
                        "filesCopied": index + (1 if force else 0),
                        "totalFiles": len(original_files),
                    },
                )

            try:
                safe_chunk_copy(source, destination, on_progress=publish_broll_progress)
            except Exception:
                try:
                    os.remove(destination)
                except OSError:
                    pass
                raise
            if os.path.getsize(source) != os.path.getsize(destination):
                try:
                    os.remove(destination)
                except OSError:
                    pass
                raise IOError(f"复制校验失败：{os.path.basename(source)}")
            created_files.append(destination)
            completed_bytes += source_size
            publish_broll_progress(0, True)

        # The source card is only cleaned after every destination file has passed validation.
        source_cleanup_started = True
        for source in original_files:
            os.remove(source)
        log_success("花絮导入完成，SD 卡已安全清理", {
            "projectNames": sorted({os.path.basename(os.path.normpath(project_path)) for project_path in (file_routes.values() or [dest_path])}),
            "importedCount": len(created_files),
            "destination": dest_path,
            "dateFolders": sorted({os.path.basename(os.path.dirname(file_path)) for file_path in created_files}),
        })
    except Exception as error:
        # Before source cleanup starts, remove a partial destination so retrying
        # is unambiguous. Once cleanup has begun, destination copies are the
        # only remaining copy for any source already deleted and must be kept.
        if not source_cleanup_started:
            for destination in created_files:
                try:
                    os.remove(destination)
                except OSError:
                    pass
            for directory in reversed(created_date_folders):
                try:
                    os.rmdir(directory)
                except OSError:
                    pass
            log_error(f"花絮导入失败，SD 卡原文件已保留：{error}")
        else:
            log_error(f"花絮文件已完整复制，但清理 SD 卡时失败；目标文件已保留，请手动检查卡内剩余文件：{error}")
        gc.collect()

def run(args_list):
    if sys.platform.startswith('win'):
        if sys.stdout: sys.stdout.reconfigure(encoding='utf-8')
        if sys.stderr: sys.stderr.reconfigure(encoding='utf-8')
        
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True)
    parser.add_argument("--sd_path", default="")
    parser.add_argument("--dest_path", default="")
    parser.add_argument("--backup_path", default="")
    parser.add_argument("--time_gap", type=float, default=2.0)
    parser.add_argument("--should_split", type=str, default="")
    parser.add_argument("--generate_video_preview", action="store_true")
    parser.add_argument("--split_large_files", action="store_true")
    parser.add_argument("--projects_json", default="[]")
    parser.add_argument("--project_routes", default="{}")
    parser.add_argument("--import_type", choices=("work", "broll"), default="work")
    parser.add_argument("--direct_project", action="store_true")

    args, _ = parser.parse_known_args(args_list)
    
    split_val = None
    if args.should_split.lower() == 'true': split_val = True
    elif args.should_split.lower() == 'false': split_val = False

    if args.stage == 'check':
        log_status("SD Card Detected" if os.path.exists(args.sd_path) else "No Device", {"connected": os.path.exists(args.sd_path), "path": args.sd_path})
    elif args.stage == 'plan':
        stage_plan_import(args.sd_path, args.projects_json, args.import_type, args.time_gap)
    elif args.stage == 'import':
        stage_import_and_organize(args.sd_path, args.dest_path, args.backup_path, args.time_gap, split_val, args.generate_video_preview, args.split_large_files, json.loads(args.project_routes or '{}'), args.direct_project)
    elif args.stage == 'broll':
        stage_import_broll(args.sd_path, args.dest_path, json.loads(args.project_routes or '{}'))

if __name__ == "__main__":
    run(sys.argv[1:])
