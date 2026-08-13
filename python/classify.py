import sys
import os
import shutil
import time
import datetime
import argparse
import subprocess
import re
import json
import functools
import hashlib
import math
import ctypes
import uuid
from pathlib import Path
import gc
from PIL import Image
from event_protocol import ask_user, emit, log_error, log_info, log_progress, log_status, log_success
from ffmpeg_transcode import (
    FFmpegTranscodeError,
    VIDEO_PREVIEW_QUALITY_PROFILES,
    normalize_video_preview_quality,
    probe_creation_time_values,
    split_video_by_size,
    transcode_video,
    transcode_video_preview,
)
from thumbnail_image import _embedded_jpeg

EXIFTOOL_PATH = ''
CAPTURE_TIME_MEMORY_CACHE = {}
CAPTURE_TIME_MEMORY_CACHE_LIMIT = 100000

CANCEL_FILE = ''


class ImportCancelled(Exception):
    pass


class SourceIdentityMismatch(OSError):
    pass


def ensure_not_cancelled():
    if CANCEL_FILE and os.path.exists(CANCEL_FILE):
        raise ImportCancelled('导入已取消')

# --- 2. 辅助工具函数 ---
def safe_chunk_copy(src, dst, chunk_size=4 * 1024 * 1024, on_progress=None):
    bytes_copied = 0
    try:
        with open(src, 'rb') as fsrc, open(dst, 'wb') as fdst:
            while True:
                ensure_not_cancelled()
                buf = fsrc.read(chunk_size)
                if not buf:
                    break
                fdst.write(buf)
                bytes_copied += len(buf)
                if on_progress:
                    on_progress(bytes_copied)
        
        shutil.copystat(src, dst)
    except Exception as e:
        # 如果中途出错（比如读卡器突然拔出），with open 会确保文件句柄被立即强制关闭
        # 避免 Windows 内核锁死
        try:
            os.remove(dst)
        except OSError:
            pass
        raise e


def ensure_import_disk_space(destination, required_bytes, purpose='导入'):
    """Fail before copying when the destination cannot safely hold the requested data."""
    required = max(0, int(required_bytes or 0))
    if not required:
        return
    usage = shutil.disk_usage(destination)
    reserve = max(512 * 1024 * 1024, min(5 * 1024 * 1024 * 1024, int(required * 0.02)))
    if usage.free < required + reserve:
        missing = required + reserve - usage.free
        raise OSError(f'{purpose}磁盘空间不足，还需要约 {missing / (1024 ** 3):.2f} GB 可用空间。')


def promote_staged_file(source, destination, on_progress=None, allow_atomic_move=True):
    """Move a staged file without rewriting it when both paths share a volume."""
    if os.path.exists(destination):
        raise FileExistsError(f'目标中已出现同名文件：{os.path.basename(destination)}')
    if allow_atomic_move:
        try:
            same_volume = os.stat(source).st_dev == os.stat(os.path.dirname(destination)).st_dev
        except OSError:
            same_volume = False
        if same_volume:
            try:
                os.replace(source, destination)
                return True
            except OSError:
                # Some filesystems or security products can reject metadata-only
                # moves. Retain the verified copy path as a safe fallback.
                if not os.path.exists(source):
                    raise
    safe_chunk_copy(source, destination, on_progress=on_progress)
    return False

VALID_MEDIA_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.hif', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.mp4', '.mov', '.avi', '.crm', '.rwl', '.raf', '.3fr', '.fff')
IMPORT_DATE_FILTERS = ('all', 'today', 'today_yesterday')
RAW_EXTENSIONS = ('.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.rwl', '.raf', '.3fr', '.fff')
JPG_EXTENSIONS = ('.jpg', '.jpeg')
VIDEO_EXTENSIONS = ('.mp4', '.mov', '.avi', '.crm')
FOUR_GB = 4 * 1024 * 1024 * 1024
SPLIT_TARGET_BYTES = int(3.95 * 1024 * 1024 * 1024)


def _parse_capture_timestamp(value):
    text = str(value or '').strip().strip('\x00')
    if not text:
        return None
    normalized = text.replace('Z', '+00:00') if text.endswith('Z') else text
    for parser in (
        lambda: datetime.datetime.fromisoformat(normalized),
        lambda: datetime.datetime.strptime(text[:19], '%Y:%m:%d %H:%M:%S'),
        lambda: datetime.datetime.strptime(text[:19], '%Y-%m-%d %H:%M:%S'),
    ):
        try:
            timestamp = parser().timestamp()
            if timestamp > 0:
                return timestamp
        except (TypeError, ValueError, OverflowError):
            continue
    return None


def _image_capture_timestamp(file_path):
    extension = os.path.splitext(file_path)[1].lower()
    image = None
    try:
        image = _embedded_jpeg(file_path) if extension in RAW_EXTENSIONS else Image.open(file_path)
        exif = image.getexif()
        for tag in (36867, 36868, 306):  # DateTimeOriginal, DateTimeDigitized, DateTime
            timestamp = _parse_capture_timestamp(exif.get(tag))
            if timestamp is not None:
                return timestamp
    except Exception:
        return None
    finally:
        if image is not None:
            image.close()
    return None


def _video_capture_timestamp(file_path):
    try:
        for value in probe_creation_time_values(file_path, timeout=15):
            timestamp = _parse_capture_timestamp(value)
            if timestamp is not None:
                return timestamp
    except (OSError, subprocess.SubprocessError):
        return None
    return None


@functools.lru_cache(maxsize=8192)
def get_file_time(file_path):
    """Prefer the media capture time; use filesystem mtime only as a fallback."""
    extension = os.path.splitext(file_path)[1].lower()
    timestamp = _video_capture_timestamp(file_path) if extension in VIDEO_EXTENSIONS else _image_capture_timestamp(file_path)
    if timestamp is not None:
        return timestamp
    try:
        return os.path.getmtime(file_path)
    except OSError as error:
        raise OSError(f'无法读取媒体文件时间：{file_path}') from error


def _capture_cache_records(file_paths):
    records = []
    for file_path in file_paths:
        ensure_not_cancelled()
        absolute_path = os.path.abspath(file_path)
        stat = os.stat(absolute_path)
        records.append({
            'filePath': absolute_path,
            'cachePath': os.path.normcase(absolute_path),
            'size': int(stat.st_size),
            'mtimeNs': int(stat.st_mtime_ns),
        })
    return records


def _capture_memory_key(record):
    return record['cachePath'], record['size'], record['mtimeNs']


def _remember_capture_times(records, capture_times):
    for record in records:
        timestamp = capture_times.get(record['cachePath'])
        if timestamp is not None and timestamp > 0:
            CAPTURE_TIME_MEMORY_CACHE[_capture_memory_key(record)] = float(timestamp)
    while len(CAPTURE_TIME_MEMORY_CACHE) > CAPTURE_TIME_MEMORY_CACHE_LIMIT:
        CAPTURE_TIME_MEMORY_CACHE.pop(next(iter(CAPTURE_TIME_MEMORY_CACHE)))


def _timestamp_from_exiftool_value(value):
    if isinstance(value, (int, float)) and float(value) > 0:
        return float(value)
    text = str(value or '').strip()
    numeric = re.fullmatch(r'(-?\d+(?:\.\d+)?)', text)
    if numeric:
        try:
            timestamp = float(numeric.group(1))
            if timestamp > 0:
                return timestamp
        except ValueError:
            pass
    return _parse_capture_timestamp(text)


def _read_exiftool_capture_times(file_paths, fast=True):
    if not EXIFTOOL_PATH or not os.path.isfile(EXIFTOOL_PATH) or not file_paths:
        return None
    command = [
        EXIFTOOL_PATH,
        '-charset', 'filename=UTF8',
        '-json', '-G1', '-n', '-fast2' if fast else '-fast', '-d', '%s',
        '-api', 'QuickTimeUTC=1',
        '-DateTimeOriginal', '-CreateDate', '-MediaCreateDate', '-TrackCreateDate', '-CreationDate', '-ModifyDate',
        '-@', '-',
    ]
    argument_stream = '--\n' + '\n'.join(os.path.abspath(file_path) for file_path in file_paths) + '\n'
    try:
        result = subprocess.run(
            command,
            input=argument_stream,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=max(30, min(600, len(file_paths) * 2)),
        )
        if result.returncode not in (0, 1) or not result.stdout.strip():
            return None
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError):
        return None
    capture_times = {}
    video_priority = ('MediaCreateDate', 'TrackCreateDate', 'CreationDate', 'CreateDate', 'DateTimeOriginal', 'ModifyDate')
    image_priority = ('DateTimeOriginal', 'CreateDate', 'ModifyDate', 'MediaCreateDate', 'TrackCreateDate', 'CreationDate')
    for item in payload if isinstance(payload, list) else []:
        if not isinstance(item, dict):
            continue
        source_path = str(item.get('SourceFile') or '')
        if not source_path:
            continue
        values = {str(key).split(':')[-1]: value for key, value in item.items()}
        extension = os.path.splitext(source_path)[1].lower()
        for tag in video_priority if extension in VIDEO_EXTENSIONS else image_priority:
            timestamp = _timestamp_from_exiftool_value(values.get(tag))
            if timestamp is not None:
                capture_times[os.path.normcase(os.path.abspath(source_path))] = timestamp
                break
    return capture_times


def capture_times_for_files(file_paths, on_progress=None):
    """Read real capture times in one ExifTool process and reuse them only in this task."""
    records = _capture_cache_records(file_paths)
    cached = {
        record['cachePath']: CAPTURE_TIME_MEMORY_CACHE[_capture_memory_key(record)]
        for record in records
        if _capture_memory_key(record) in CAPTURE_TIME_MEMORY_CACHE
    }
    missing_records = [record for record in records if record['cachePath'] not in cached]
    missing_paths = [record['filePath'] for record in missing_records]
    batch_values = _read_exiftool_capture_times(missing_paths, fast=True) if missing_paths else {}
    resolved = dict(cached)
    if batch_values is None:
        for record in missing_records:
            ensure_not_cancelled()
            resolved[record['cachePath']] = get_file_time(record['filePath'])
    else:
        slow_records = [record for record in missing_records if record['cachePath'] not in batch_values]
        if slow_records:
            slow_values = _read_exiftool_capture_times([record['filePath'] for record in slow_records], fast=False)
            if slow_values:
                batch_values.update(slow_values)
        for record in missing_records:
            timestamp = batch_values.get(record['cachePath'])
            resolved[record['cachePath']] = timestamp if timestamp is not None else os.path.getmtime(record['filePath'])
    _remember_capture_times(missing_records, resolved)
    timed_files = []
    total_files = len(records)
    for file_index, record in enumerate(records, start=1):
        ensure_not_cancelled()
        timestamp = resolved[record['cachePath']]
        timed_files.append((record['filePath'], timestamp))
        if on_progress:
            on_progress(file_index, total_files, record['filePath'])
    return timed_files

def scan_sd_media(sd_path):
    normalized_sd = os.path.normpath(sd_path)
    base_sd = os.path.dirname(normalized_sd) if normalized_sd.upper().endswith('DCIM') else normalized_sd
    files = []
    for target_dir in (os.path.join(base_sd, 'DCIM'), os.path.join(base_sd, 'PRIVATE')):
        if not os.path.exists(target_dir):
            continue
        for root, dirs, names in os.walk(target_dir):
            ensure_not_cancelled()
            dirs[:] = [directory for directory in dirs if not directory.startswith('.')]
            files.extend(
                os.path.join(root, name)
                for name in names
                if not name.startswith('.') and name.lower().endswith(VALID_MEDIA_EXTENSIONS)
            )
    return base_sd, files

def scan_direct_media(source_path):
    """Read an explicitly selected file or directory without SD-card layout rules."""
    normalized_source = os.path.normpath(source_path)
    if os.path.isfile(normalized_source):
        files = [normalized_source] if normalized_source.lower().endswith(VALID_MEDIA_EXTENSIONS) else []
        return os.path.dirname(normalized_source), files
    files = []
    if os.path.isdir(normalized_source):
        for root, dirs, names in os.walk(normalized_source):
            ensure_not_cancelled()
            dirs[:] = [directory for directory in dirs if not directory.startswith('.')]
            files.extend(
                os.path.join(root, name)
                for name in names
                if not name.startswith('.') and name.lower().endswith(VALID_MEDIA_EXTENSIONS)
            )
    return normalized_source, files

def scan_import_media(source_path, direct_source=False, source_paths=None):
    if not direct_source:
        return scan_sd_media(source_path)
    selected_sources = source_paths or [source_path]
    files = []
    seen = set()
    for selected_source in selected_sources:
        ensure_not_cancelled()
        _root, selected_files = scan_direct_media(selected_source)
        for file_path in selected_files:
            ensure_not_cancelled()
            normalized = os.path.normcase(os.path.abspath(file_path))
            if normalized in seen:
                continue
            seen.add(normalized)
            files.append(file_path)
    root_label = os.path.dirname(selected_sources[0]) if len(selected_sources) > 1 and os.path.isfile(selected_sources[0]) else selected_sources[0]
    return os.path.normpath(root_label), files


def filter_media_by_capture_date(files, date_filter='all', today=None, on_progress=None):
    """Filter by local capture date without reading metadata when filtering is disabled."""
    normalized_filter = date_filter if date_filter in IMPORT_DATE_FILTERS else 'all'
    if normalized_filter == 'all':
        return list(files), {}
    current_date = today or datetime.date.today()
    allowed_dates = {current_date}
    if normalized_filter == 'today_yesterday':
        allowed_dates.add(current_date - datetime.timedelta(days=1))
    selected = []
    capture_times = {}
    timed_files = capture_times_for_files(files)
    total_files = len(timed_files)
    for file_index, (file_path, timestamp) in enumerate(timed_files, start=1):
        ensure_not_cancelled()
        matched = datetime.datetime.fromtimestamp(timestamp).date() in allowed_dates
        if matched:
            selected.append(file_path)
            capture_times[os.path.normcase(os.path.abspath(file_path))] = float(timestamp)
        if on_progress:
            on_progress(file_index, total_files, file_path, len(selected))
    return selected, capture_times


STAGING_MANIFEST_NAME = '.photoflow-import-manifest.json'
IMPORT_GRAPH_RECEIPT_NAME = '.photoflow-import-graph-receipt.json'
STAGING_RETENTION_SECONDS = 30 * 24 * 60 * 60
SOURCE_FINGERPRINT_BYTES = 64 * 1024


def _source_volume_identity(source_path):
    absolute_path = os.path.abspath(source_path)
    if os.name == 'nt':
        drive, _tail = os.path.splitdrive(absolute_path)
        root = f'{drive}\\' if drive else absolute_path
        serial = ctypes.c_ulong(0)
        maximum_component = ctypes.c_ulong(0)
        flags = ctypes.c_ulong(0)
        volume_name = ctypes.create_unicode_buffer(261)
        filesystem_name = ctypes.create_unicode_buffer(261)
        try:
            succeeded = ctypes.windll.kernel32.GetVolumeInformationW(
                ctypes.c_wchar_p(root), volume_name, len(volume_name), ctypes.byref(serial),
                ctypes.byref(maximum_component), ctypes.byref(flags), filesystem_name, len(filesystem_name),
            )
            if succeeded:
                return f'windows:{serial.value:08x}:{filesystem_name.value.casefold()}:{volume_name.value.casefold()}'
        except (AttributeError, OSError, ValueError):
            pass
    try:
        return f'posix:{os.stat(absolute_path).st_dev}'
    except OSError:
        return ''


def _source_sample_fingerprint(file_path, size=None):
    file_size = os.path.getsize(file_path) if size is None else int(size)
    digest = hashlib.sha256()
    with open(file_path, 'rb') as source:
        digest.update(source.read(SOURCE_FINGERPRINT_BYTES))
        if file_size > SOURCE_FINGERPRINT_BYTES:
            source.seek(max(0, file_size - SOURCE_FINGERPRINT_BYTES))
            digest.update(source.read(SOURCE_FINGERPRINT_BYTES))
    digest.update(str(file_size).encode('ascii'))
    return digest.hexdigest()


def _source_entry_metadata(file_path):
    stat = os.stat(file_path)
    return {
        'size': int(stat.st_size),
        'sourceMtimeNs': int(stat.st_mtime_ns),
        'sourceFingerprint': _source_sample_fingerprint(file_path, stat.st_size),
    }


def _entry_current_source_status(entry):
    source_path = os.path.abspath(str(entry.get('source') or ''))
    try:
        current = _source_entry_metadata(source_path)
    except OSError:
        return 'missing'
    if current['size'] != int(entry.get('size') or -1):
        return 'changed'
    stored_mtime = entry.get('sourceMtimeNs')
    if isinstance(stored_mtime, int) and stored_mtime != current['sourceMtimeNs']:
        return 'changed'
    stored_fingerprint = str(entry.get('sourceFingerprint') or '')
    return 'match' if not stored_fingerprint or stored_fingerprint == current['sourceFingerprint'] else 'changed'


def _entry_matches_current_source(entry):
    return _entry_current_source_status(entry) == 'match'


def _validate_staged_source_identity(staged_import):
    """Return whether the original source is still present and unchanged."""
    base_source = str(staged_import.get('baseSource') or '')
    if not base_source or not os.path.exists(base_source):
        return False
    if int(staged_import.get('manifestVersion') or 0) < 2:
        raise SourceIdentityMismatch('旧版暂存缺少 SD 卡身份，旧暂存不会用于当前卡。')
    stored_volume = str(staged_import.get('sourceVolumeIdentity') or '')
    current_volume = _source_volume_identity(base_source)
    if stored_volume and current_volume and stored_volume != current_volume:
        raise SourceIdentityMismatch('检测到 SD 卡已经更换，旧暂存不会用于当前卡。')
    entries = staged_import.get('entries') or []
    statuses = [_entry_current_source_status(entry) for entry in entries]
    for entry, status in zip(entries, statuses):
        if status == 'changed':
            raise SourceIdentityMismatch(f"检测到源文件已变化：{os.path.basename(str(entry.get('source') or ''))}")
    return bool(entries) and all(status == 'match' for status in statuses)


def cleanup_expired_import_staging(dest_path, retention_seconds=STAGING_RETENTION_SECONDS):
    staging_root = os.path.join(os.path.abspath(dest_path), '_PhotoFlow_Safety_Temp')
    if not os.path.isdir(staging_root):
        return 0
    cutoff = time.time() - max(0, retention_seconds)
    removed = 0
    for name in os.listdir(staging_root):
        session_dir = os.path.join(staging_root, name)
        manifest_path = _staging_manifest_path(session_dir)
        if os.path.isfile(_import_graph_receipt_path(session_dir)):
            continue
        try:
            if os.path.isdir(session_dir) and os.path.getmtime(manifest_path) < cutoff:
                shutil.rmtree(session_dir)
                removed += 1
        except OSError:
            continue
    try:
        os.rmdir(staging_root)
    except OSError:
        pass
    return removed


def get_import_staging_dir(dest_path, import_session=''):
    session_name = re.sub(r'[^a-zA-Z0-9_-]', '', str(import_session or ''))[:80] or 'default'
    return os.path.join(os.path.abspath(dest_path), '_PhotoFlow_Safety_Temp', session_name)


def _staging_manifest_path(staging_dir):
    return os.path.join(staging_dir, STAGING_MANIFEST_NAME)


def _write_staging_manifest(staging_dir, payload):
    os.makedirs(staging_dir, exist_ok=True)
    manifest_path = _staging_manifest_path(staging_dir)
    temporary_path = f'{manifest_path}.tmp-{os.getpid()}'
    with open(temporary_path, 'w', encoding='utf-8') as manifest_file:
        json.dump(payload, manifest_file, ensure_ascii=False, indent=2)
        manifest_file.flush()
        os.fsync(manifest_file.fileno())
    os.replace(temporary_path, manifest_path)


def _import_graph_receipt_path(staging_dir):
    return os.path.join(staging_dir, IMPORT_GRAPH_RECEIPT_NAME)


def write_import_graph_receipt(staging_dir, import_session, manifests):
    """Persist the authoritative graph handoff before reporting import success."""
    session_id = str(import_session or '').strip()
    if not session_id:
        raise ValueError('import_session_required: import session is required before media is moved')
    normalized = list(manifests or [])
    if not normalized or any(not isinstance(item, dict) or item.get('schemaVersion') != 2 or item.get('importSessionId') != session_id for item in normalized):
        raise ValueError('import_receipt_invalid: receipt manifests must use schema version 2 and the active session')
    payload = {
        'receiptVersion': 1,
        'importSessionId': session_id,
        'manifests': normalized,
        'createdAt': int(time.time() * 1000),
    }
    os.makedirs(staging_dir, exist_ok=True)
    receipt_path = _import_graph_receipt_path(staging_dir)
    temporary_path = f'{receipt_path}.tmp-{os.getpid()}'
    with open(temporary_path, 'w', encoding='utf-8') as receipt_file:
        json.dump(payload, receipt_file, ensure_ascii=False, indent=2)
        receipt_file.flush()
        os.fsync(receipt_file.fileno())
    os.replace(temporary_path, receipt_path)
    return receipt_path


def load_import_graph_receipt(staging_dir):
    try:
        with open(_import_graph_receipt_path(staging_dir), 'r', encoding='utf-8') as receipt_file:
            payload = json.load(receipt_file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get('receiptVersion') != 1 or not str(payload.get('importSessionId') or '').strip() or not isinstance(payload.get('manifests'), list):
        return None
    return payload


def load_staged_import(dest_path, import_session=''):
    staging_dir = get_import_staging_dir(dest_path, import_session)
    manifest_path = _staging_manifest_path(staging_dir)
    try:
        with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
            manifest = json.load(manifest_file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    entries = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not entries:
        return None
    normalized_staging = os.path.abspath(staging_dir)
    normalized_destination_root = os.path.abspath(dest_path)
    originals = []
    local_files = []
    normalized_entries = []
    timed_files = []
    has_complete_capture_times = True
    total_bytes = 0
    for entry in entries:
        if not isinstance(entry, dict):
            return None
        raw_source_path = str(entry.get('source') or '')
        raw_staged_path = str(entry.get('staged') or '')
        if not raw_source_path or not raw_staged_path:
            return None
        source_path = os.path.abspath(raw_source_path)
        staged_path = os.path.abspath(raw_staged_path)
        expected_size = int(entry.get('size') or 0)
        committed_path = os.path.abspath(str(entry.get('committedDestination') or entry.get('pendingDestination') or '')) if entry.get('committedDestination') or entry.get('pendingDestination') else ''
        output_paths = [os.path.abspath(str(value)) for value in entry.get('outputPaths', []) if value]
        try:
            inside_staging = os.path.commonpath((normalized_staging, staged_path)) == normalized_staging
            committed_inside_destination = not committed_path or os.path.commonpath((normalized_destination_root, committed_path)) == normalized_destination_root
            outputs_inside_destination = all(os.path.commonpath((normalized_destination_root, value)) == normalized_destination_root for value in output_paths)
        except ValueError:
            inside_staging = False
            committed_inside_destination = False
            outputs_inside_destination = False
        staged_valid = inside_staging and os.path.isfile(staged_path) and os.path.getsize(staged_path) == expected_size
        committed_valid = committed_inside_destination and committed_path and os.path.isfile(committed_path) and os.path.getsize(committed_path) == expected_size
        outputs_valid = outputs_inside_destination and output_paths and all(os.path.isfile(value) and os.path.getsize(value) > 0 for value in output_paths)
        if expected_size < 0 or not (staged_valid or committed_valid or outputs_valid):
            return None
        local_path = output_paths[0] if outputs_valid else committed_path if committed_valid else staged_path
        normalized_entry = dict(entry)
        normalized_entry.update({'source': source_path, 'staged': staged_path, 'size': expected_size, 'localPath': local_path})
        if committed_valid and not normalized_entry.get('committedDestination'):
            normalized_entry['committedDestination'] = committed_path
        originals.append(source_path)
        local_files.append(local_path)
        normalized_entries.append(normalized_entry)
        capture_timestamp = entry.get('captureTimestamp')
        if isinstance(capture_timestamp, (int, float)) and capture_timestamp > 0:
            timed_files.append((local_path, float(capture_timestamp)))
        else:
            has_complete_capture_times = False
        total_bytes += expected_size
    return {
        'stagingDir': staging_dir,
        'baseSource': str(manifest.get('baseSource') or ''),
        'originalFiles': originals,
        'stagedFiles': local_files,
        'entries': normalized_entries,
        'timedFiles': timed_files if has_complete_capture_times else [],
        'totalBytes': total_bytes,
        'dateFilter': str(manifest.get('dateFilter') or 'all'),
        'sourceFileCount': int(manifest.get('sourceFileCount') or len(originals)),
        'sourceVolumeIdentity': str(manifest.get('sourceVolumeIdentity') or ''),
        'manifestVersion': int(manifest.get('version') or 0),
    }


def save_staged_capture_times(staged_import, timed_files):
    """Persist metadata extracted from local copies so confirmation never probes it twice."""
    staging_dir = staged_import['stagingDir']
    manifest_path = _staging_manifest_path(staging_dir)
    with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
        manifest = json.load(manifest_file)
    capture_times = {
        os.path.normcase(os.path.abspath(file_path)): float(timestamp)
        for file_path, timestamp in timed_files
        if timestamp is not None and timestamp > 0
    }
    entries = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or len(capture_times) != len(entries):
        raise IOError('无法保存完整的拍摄时间缓存')
    for entry in entries:
        candidates = [entry.get('staged'), entry.get('committedDestination'), entry.get('pendingDestination'), *(entry.get('outputPaths') or [])]
        matching_path = next((os.path.normcase(os.path.abspath(str(value))) for value in candidates if value and os.path.normcase(os.path.abspath(str(value))) in capture_times), '')
        if not matching_path:
            raise IOError('拍摄时间缓存与暂存文件不一致')
        entry['captureTimestamp'] = capture_times[matching_path]
    _write_staging_manifest(staging_dir, manifest)
    staged_import['timedFiles'] = [
        (file_path, capture_times[os.path.normcase(os.path.abspath(file_path))])
        for file_path in staged_import['stagedFiles']
    ]


def update_staged_entry(staged_import, staged_path, patch):
    staging_dir = staged_import['stagingDir']
    manifest_path = _staging_manifest_path(staging_dir)
    with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
        manifest = json.load(manifest_file)
    entries = manifest.get('files') if isinstance(manifest, dict) else None
    normalized_staged = os.path.normcase(os.path.abspath(staged_path))
    target = next((entry for entry in entries or [] if os.path.normcase(os.path.abspath(str(entry.get('staged') or ''))) == normalized_staged), None)
    if target is None:
        raise IOError(f'暂存清单中找不到文件：{os.path.basename(staged_path)}')
    for key, value in patch.items():
        if value is None:
            target.pop(key, None)
        else:
            target[key] = value
    _write_staging_manifest(staging_dir, manifest)
    for entry in staged_import.get('entries') or []:
        if os.path.normcase(os.path.abspath(str(entry.get('staged') or ''))) == normalized_staged:
            for key, value in patch.items():
                if value is None:
                    entry.pop(key, None)
                else:
                    entry[key] = value
            break


def staged_entry_for_local_path(staged_import, local_path):
    normalized_local = os.path.normcase(os.path.abspath(local_path))
    for entry in staged_import.get('entries') or []:
        candidates = [entry.get('localPath'), entry.get('staged'), entry.get('committedDestination'), entry.get('pendingDestination'), *(entry.get('outputPaths') or [])]
        if any(value and os.path.normcase(os.path.abspath(str(value))) == normalized_local for value in candidates):
            return entry
    return None


def staged_files_with_capture_times(staged_import):
    cached = staged_import.get('timedFiles') or []
    if len(cached) == len(staged_import.get('stagedFiles') or []):
        return cached
    timed_files = capture_times_for_files(staged_import['stagedFiles'])
    save_staged_capture_times(staged_import, timed_files)
    return timed_files


def _unique_staged_path(staging_dir, source_path, used_paths):
    file_name = os.path.basename(source_path)
    stem, extension = os.path.splitext(file_name)
    candidate = os.path.join(staging_dir, file_name)
    normalized = os.path.normcase(os.path.abspath(candidate))
    if normalized not in used_paths and not os.path.exists(candidate):
        used_paths.add(normalized)
        return candidate
    digest = hashlib.sha256(os.path.abspath(source_path).encode('utf-8', errors='surrogatepass')).hexdigest()[:8]
    index = 0
    while True:
        suffix = f'_{digest}' if index == 0 else f'_{digest}_{index}'
        candidate = os.path.join(staging_dir, f'{stem}{suffix}{extension}')
        normalized = os.path.normcase(os.path.abspath(candidate))
        if normalized not in used_paths and not os.path.exists(candidate):
            used_paths.add(normalized)
            return candidate
        index += 1


def _resumable_staging_entries(staging_dir, source_volume_identity=''):
    """Return safe prior manifest entries so a reconnected card can resume."""
    manifest_path = _staging_manifest_path(staging_dir)
    try:
        with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
            manifest = json.load(manifest_file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}
    raw_entries = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(raw_entries, list):
        return {}
    if int(manifest.get('version') or 0) < 2 and raw_entries:
        raise SourceIdentityMismatch('旧版暂存缺少 SD 卡身份，旧暂存不会用于当前卡。')
    stored_volume_identity = str(manifest.get('sourceVolumeIdentity') or '')
    if stored_volume_identity and source_volume_identity and stored_volume_identity != source_volume_identity:
        raise SourceIdentityMismatch('检测到 SD 卡已经更换，旧暂存不会用于当前卡。')
    normalized_staging = os.path.abspath(staging_dir)
    entries = {}
    for entry in raw_entries:
        if not isinstance(entry, dict):
            continue
        source_path = os.path.abspath(str(entry.get('source') or ''))
        staged_path = os.path.abspath(str(entry.get('staged') or ''))
        try:
            expected_size = int(entry.get('size'))
            inside_staging = os.path.commonpath((normalized_staging, staged_path)) == normalized_staging
        except (TypeError, ValueError, OSError):
            continue
        if not source_path or not staged_path or not inside_staging or expected_size < 0:
            continue
        entries[os.path.normcase(source_path)] = {
            'source': source_path,
            'staged': staged_path,
            'size': expected_size,
            **({'sourceMtimeNs': entry['sourceMtimeNs']} if isinstance(entry.get('sourceMtimeNs'), int) else {}),
            **({'sourceFingerprint': entry['sourceFingerprint']} if entry.get('sourceFingerprint') else {}),
            **({'captureTimestamp': entry['captureTimestamp']} if isinstance(entry.get('captureTimestamp'), (int, float)) and entry['captureTimestamp'] > 0 else {}),
        }
    return entries


def stage_media_to_safety_temp(sd_path, dest_path, direct_source=False, source_paths=None, import_session='', progress_end=70, date_filter='all'):
    cleanup_expired_import_staging(dest_path)
    existing = load_staged_import(dest_path, import_session)
    if existing:
        existing['sourceValidated'] = _validate_staged_source_identity(existing)
        log_progress(
            '素材已导入，准备读取本地副本...',
            progress_end,
            {'bytesCopied': existing['totalBytes'], 'totalBytes': existing['totalBytes'], 'filesCopied': len(existing['stagedFiles']), 'totalFiles': len(existing['stagedFiles']), 'stagingComplete': True},
        )
        return existing

    log_progress('正在扫描导入来源...', 0, {'bytesCopied': 0, 'totalBytes': 0, 'filesCopied': 0, 'totalFiles': 0})
    base_source, original_files = scan_import_media(sd_path, direct_source, source_paths)
    source_volume_identity = _source_volume_identity(base_source)
    source_file_count = len(original_files)
    normalized_date_filter = date_filter if date_filter in IMPORT_DATE_FILTERS else 'all'
    capture_times = {}
    copy_progress_start = 5
    if normalized_date_filter != 'all' and original_files:
        copy_progress_start = 12
        log_progress('正在按拍摄日期筛选 SD 卡素材...', 1, {'filesProcessed': 0, 'totalFiles': source_file_count, 'matchedFiles': 0})

        def publish_date_filter_progress(file_index, file_count, file_path, matched_count):
            log_progress(
                f'正在读取拍摄时间：{os.path.basename(file_path)}（{file_index}/{file_count}）',
                1 + int((file_index / max(1, file_count)) * 9),
                {'filesProcessed': file_index, 'totalFiles': file_count, 'matchedFiles': matched_count, 'fileName': os.path.basename(file_path)},
            )

        original_files, capture_times = filter_media_by_capture_date(
            original_files,
            normalized_date_filter,
            on_progress=publish_date_filter_progress,
        )
        log_progress(
            f'日期筛选完成：扫描 {source_file_count} 个文件，符合条件 {len(original_files)} 个。',
            10,
            {'filesProcessed': source_file_count, 'totalFiles': source_file_count, 'matchedFiles': len(original_files)},
        )
    if not original_files:
        return {
            'stagingDir': get_import_staging_dir(dest_path, import_session),
            'baseSource': base_source,
            'originalFiles': [],
            'stagedFiles': [],
            'totalBytes': 0,
            'timedFiles': [],
            'dateFilter': normalized_date_filter,
            'sourceFileCount': source_file_count,
            'sourceVolumeIdentity': source_volume_identity,
            'manifestVersion': 2,
            'sourceValidated': bool(base_source and os.path.exists(base_source)),
            'entries': [],
        }

    staging_dir = get_import_staging_dir(dest_path, import_session)
    os.makedirs(staging_dir, exist_ok=True)
    prior_entries = _resumable_staging_entries(staging_dir, source_volume_identity)
    used_paths = set()
    entries = []
    for source_path in original_files:
        ensure_not_cancelled()
        source_path = os.path.abspath(source_path)
        source_metadata = _source_entry_metadata(source_path)
        source_size = source_metadata['size']
        prior_entry = prior_entries.get(os.path.normcase(source_path))
        if prior_entry and prior_entry['size'] == source_size and _entry_matches_current_source(prior_entry):
            staged_path = prior_entry['staged']
            used_paths.add(os.path.normcase(os.path.abspath(staged_path)))
        else:
            staged_path = _unique_staged_path(staging_dir, source_path, used_paths)
        entry = {'source': source_path, 'staged': staged_path, **source_metadata}
        capture_timestamp = capture_times.get(os.path.normcase(source_path))
        if capture_timestamp is None and prior_entry:
            capture_timestamp = prior_entry.get('captureTimestamp')
        if capture_timestamp is not None:
            entry['captureTimestamp'] = capture_timestamp
        entries.append(entry)
    manifest = {'version': 2, 'baseSource': base_source, 'sourceVolumeIdentity': source_volume_identity, 'dateFilter': normalized_date_filter, 'sourceFileCount': source_file_count, 'files': entries}
    _write_staging_manifest(staging_dir, manifest)

    total_bytes = sum(entry['size'] for entry in entries)
    completed_entries = set()
    completed_bytes = 0
    for entry in entries:
        staged_path = entry['staged']
        try:
            if os.path.isfile(staged_path) and os.path.getsize(staged_path) == entry['size']:
                completed_entries.add(os.path.normcase(os.path.abspath(staged_path)))
                completed_bytes += entry['size']
            elif os.path.exists(staged_path):
                os.remove(staged_path)
        except OSError:
            try:
                os.remove(staged_path)
            except OSError:
                pass
    transfer_started_at = time.monotonic()
    last_progress_at = 0.0
    completed_file_count = len(completed_entries)
    ensure_import_disk_space(dest_path, total_bytes - completed_bytes, '导入暂存')
    log_progress('扫描完成，正在导入...', copy_progress_start + int((completed_bytes / max(1, total_bytes)) * max(0, progress_end - copy_progress_start)), {'bytesCopied': completed_bytes, 'totalBytes': total_bytes, 'filesCopied': completed_file_count, 'totalFiles': len(entries), 'resumedFiles': completed_file_count})
    for file_index, entry in enumerate(entries, start=1):
        ensure_not_cancelled()
        source_path = entry['source']
        staged_path = entry['staged']
        if os.path.normcase(os.path.abspath(staged_path)) in completed_entries:
            continue

        def publish_staging_progress(current_file_bytes, force=False):
            nonlocal last_progress_at
            now = time.monotonic()
            bytes_copied = min(total_bytes, completed_bytes + current_file_bytes)
            if not force and now - last_progress_at < 0.1 and bytes_copied < total_bytes:
                return
            last_progress_at = now
            elapsed = max(0.001, now - transfer_started_at)
            log_progress(
                f'正在导入：{os.path.basename(source_path)}（{file_index}/{len(entries)}）',
                copy_progress_start + int((bytes_copied / max(1, total_bytes)) * max(0, progress_end - copy_progress_start)),
                {
                    'bytesCopied': bytes_copied,
                    'totalBytes': total_bytes,
                    'bytesPerSecond': bytes_copied / elapsed,
                    'filesCopied': completed_file_count + (1 if force else 0),
                    'totalFiles': len(entries),
                },
            )

        safe_chunk_copy(source_path, staged_path, on_progress=publish_staging_progress)
        if os.path.getsize(staged_path) != entry['size']:
            raise IOError(f'导入校验失败：{os.path.basename(source_path)}')
        completed_bytes += entry['size']
        publish_staging_progress(0, True)
        completed_file_count += 1

    log_progress(
        '素材导入完成，后续处理将使用本地副本。',
        progress_end,
        {'bytesCopied': total_bytes, 'totalBytes': total_bytes, 'filesCopied': len(entries), 'totalFiles': len(entries), 'stagingComplete': True},
    )
    return {
        'stagingDir': staging_dir,
        'baseSource': base_source,
        'originalFiles': [entry['source'] for entry in entries],
        'stagedFiles': [entry['staged'] for entry in entries],
        'timedFiles': [
            (entry['staged'], float(entry['captureTimestamp']))
            for entry in entries
            if isinstance(entry.get('captureTimestamp'), (int, float)) and entry['captureTimestamp'] > 0
        ],
        'totalBytes': total_bytes,
        'dateFilter': normalized_date_filter,
        'sourceFileCount': source_file_count,
        'sourceVolumeIdentity': source_volume_identity,
        'manifestVersion': 2,
        'sourceValidated': True,
        'entries': entries,
    }


def no_staged_media_message(staged_import, direct_source=False):
    date_filter = staged_import.get('dateFilter', 'all')
    source_file_count = int(staged_import.get('sourceFileCount') or 0)
    if source_file_count and date_filter != 'all':
        date_label = '今天' if date_filter == 'today' else '今天或昨天'
        return f'已扫描 {source_file_count} 个媒体文件，没有找到拍摄日期为{date_label}的素材。'
    base_source = staged_import.get('baseSource', '')
    return f"在 {base_source} 中没有找到媒体文件" if direct_source else f"在 {base_source} 的 DCIM/PRIVATE 目录下没有找到媒体文件"


def source_files_are_safe_to_delete(staged_import):
    entries = staged_import.get('entries') or []
    if not entries:
        return all(os.path.isfile(path) for path in staged_import.get('originalFiles') or [])
    try:
        return _validate_staged_source_identity(staged_import)
    except SourceIdentityMismatch:
        return False


def cleanup_import_staging(staging_dir):
    if os.path.isdir(staging_dir):
        shutil.rmtree(staging_dir)
    staging_root = os.path.dirname(staging_dir)
    try:
        os.rmdir(staging_root)
    except OSError:
        pass

ADAPTIVE_GAP_MIN_SECONDS = 30 * 60
ADAPTIVE_GAP_MIN_RATIO = 5.0
ADAPTIVE_GAP_MIN_SEGMENT_FILES = 3
ADAPTIVE_GAP_HARD_HOURS = 4.0


def _adaptive_capture_break_indexes(ordered, split_threshold_hours=2.0):
    """Return indexes that begin a new shoot based on this batch's gap pattern."""
    if len(ordered) < 2:
        return set()

    gaps = [(index, max(0.0, ordered[index][1] - ordered[index - 1][1])) for index in range(1, len(ordered))]
    hard_gap_seconds = max(ADAPTIVE_GAP_HARD_HOURS, float(split_threshold_hours or 0)) * 3600
    hard_breaks = {index for index, gap in gaps if gap >= hard_gap_seconds}

    log_gaps = [math.log(max(1.0, gap)) for _index, gap in gaps]
    adaptive_candidates = []
    if len(log_gaps) >= 2 and max(log_gaps) > min(log_gaps):
        centers = [min(log_gaps), max(log_gaps)]
        for _iteration in range(20):
            clusters = [[], []]
            for value in log_gaps:
                cluster_index = 0 if abs(value - centers[0]) <= abs(value - centers[1]) else 1
                clusters[cluster_index].append(value)
            if not clusters[0] or not clusters[1]:
                break
            next_centers = [sum(cluster) / len(cluster) for cluster in clusters]
            if max(abs(next_centers[index] - centers[index]) for index in (0, 1)) < 1e-6:
                centers = next_centers
                break
            centers = next_centers

        low_center, high_center = sorted(centers)
        normal_gap_seconds = math.exp(low_center)
        center_ratio = math.exp(high_center - low_center)
        adaptive_threshold = max(ADAPTIVE_GAP_MIN_SECONDS, math.exp((low_center + high_center) / 2))
        if center_ratio >= ADAPTIVE_GAP_MIN_RATIO:
            adaptive_candidates = [
                (index, gap)
                for index, gap in gaps
                if gap >= adaptive_threshold and gap >= normal_gap_seconds * ADAPTIVE_GAP_MIN_RATIO
            ]

    # Hard gaps always split. Adaptive gaps are accepted largest-first only when
    # both resulting shoots contain enough material to avoid isolated-file groups.
    breaks = set(hard_breaks)
    for index, _gap in sorted(adaptive_candidates, key=lambda item: item[1], reverse=True):
        if index in breaks:
            continue
        surrounding = [0, *sorted(breaks), len(ordered)]
        left = max(boundary for boundary in surrounding if boundary < index)
        right = min(boundary for boundary in surrounding if boundary > index)
        if index - left >= ADAPTIVE_GAP_MIN_SEGMENT_FILES and right - index >= ADAPTIVE_GAP_MIN_SEGMENT_FILES:
            breaks.add(index)
    return breaks


def _build_capture_groups_from_timed_files(files_with_time, split_threshold_hours=2.0):
    days = {}
    for file_path, timestamp in files_with_time:
        date_key = datetime.datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
        days.setdefault(date_key, []).append((file_path, timestamp))

    groups = []
    for date_key in sorted(days):
        ordered = sorted(days[date_key], key=lambda item: item[1])
        break_indexes = _adaptive_capture_break_indexes(ordered, split_threshold_hours)
        day_groups = []
        start_index = 0
        for break_index in sorted(break_indexes):
            day_groups.append(ordered[start_index:break_index])
            start_index = break_index
        day_groups.append(ordered[start_index:])
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


def build_capture_groups(files, split_threshold_hours=2.0, on_progress=None):
    """Group each capture day and identify statistically distinct shooting gaps."""
    days = {}
    timed_files = capture_times_for_files(files)
    total_files = len(timed_files)
    for file_index, (file_path, timestamp) in enumerate(timed_files, start=1):
        ensure_not_cancelled()
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f'媒体文件已不可用：{file_path}')
        if on_progress:
            on_progress(file_index, total_files, file_path)
        if timestamp is None or timestamp <= 0:
            raise OSError(f'媒体文件的拍摄时间不可用：{file_path}')
        date_key = datetime.datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
        days.setdefault(date_key, []).append((file_path, timestamp))
    return _build_capture_groups_from_timed_files(
        [item for date_items in days.values() for item in date_items],
        split_threshold_hours,
    )

def stage_plan_import(sd_path, dest_path, projects_json, import_type='work', split_threshold_hours=2.0, direct_source=False, source_paths=None, import_session='', date_filter='all'):
    if not dest_path or not os.path.isdir(dest_path):
        log_error('导入目标不存在，请重新选择工作目录。')
        return
    try:
        staged_import = stage_media_to_safety_temp(sd_path, dest_path, direct_source, source_paths, import_session, progress_end=75, date_filter=date_filter)
    except OSError as error:
        log_error(f'导入失败，源设备可能已断开，请重新连接后重试：{error}')
        return
    base_sd = staged_import['baseSource']
    files = staged_import['stagedFiles']
    if not files:
        log_success(no_staged_media_message(staged_import, direct_source), {'projectNames': [], 'importedCount': 0, 'skipped': True, 'skipReason': 'no-media'})
        return
    try:
        projects = json.loads(projects_json or '[]')
    except (TypeError, ValueError, json.JSONDecodeError):
        projects = []
    total_files = len(files)
    log_progress("素材导入完成，正在从本地副本读取拍摄时间...", 75, {"filesProcessed": 0, "totalFiles": total_files})

    def publish_capture_time_progress(file_index, file_count, file_path):
        completed = file_index - 1
        percent = 75 + int((completed / max(1, file_count)) * 20)
        log_progress(
            f"正在读取本地副本拍摄时间：{os.path.basename(file_path)}（{file_index}/{file_count}）",
            percent,
            {"filesProcessed": completed, "totalFiles": file_count, "fileName": os.path.basename(file_path)},
        )

    try:
        groups = build_capture_groups(files, split_threshold_hours, publish_capture_time_progress)
        save_staged_capture_times(
            staged_import,
            [item for group in groups for item in group['files']],
        )
    except OSError as error:
        log_error(f"读取已导入的本地副本失败，请重试导入：{error}")
        return
    log_progress("拍摄时间读取完成，正在匹配目标项目...", 95, {"filesProcessed": total_files, "totalFiles": total_files})
    payload_groups = []
    automatic_routes = {}
    requires_choice = False
    for group in groups:
        ensure_not_cancelled()
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
            'stagingComplete': True,
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


def unique_broll_destination(directory, file_name, will_split=False):
    stem, extension = os.path.splitext(file_name)
    index = 0
    while True:
        candidate_name = file_name if index == 0 else f'{stem} ({index}){extension}'
        candidate = os.path.join(directory, candidate_name)
        split_prefix = os.path.splitext(candidate_name)[0] + '_part'
        has_split_collision = will_split and any(
            name.startswith(split_prefix) and name.lower().endswith(extension.lower())
            for name in os.listdir(directory)
        )
        if not os.path.exists(candidate) and not has_split_collision:
            return candidate
        index += 1

CLASSIFY_EXTENSION_MAP = {
    'jpg': ('.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.hif'),
    'raw': ('.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.rwl', '.raf', '.3fr', '.fff'),
    'mov': ('.mp4', '.mov', '.avi', '.crm'),
}


def classified_destination_directory(folder_path, file_name):
    lowered = file_name.lower()
    subfolder = next((name for name, extensions in CLASSIFY_EXTENSION_MAP.items() if lowered.endswith(extensions)), '')
    return os.path.join(folder_path, subfolder) if subfolder else folder_path


def build_import_graph_manifest(dest_path, target_folder, project_name, import_session,
                                imported_paths, generated_jpg_paths=None, generated_preview_paths=None):
    """Describe importer-owned artifact slots from files already handled by this session."""
    target_folder = os.path.abspath(target_folder)
    imported = {os.path.abspath(value) for value in (imported_paths or [])}
    generated_jpg = {os.path.abspath(value) for value in (generated_jpg_paths or [])}
    generated_preview = {os.path.abspath(value) for value in (generated_preview_paths or [])}
    del dest_path  # Project ownership is resolved later from the trusted workspace catalog.
    session_id = str(import_session or '').strip()
    if not session_id:
        raise ValueError('import_session_required: import graph manifest requires a session')
    artifacts_by_path = {}
    display_names = {
        'raw': 'RAW', 'camera_jpg': 'JPG', 'generated_jpg': 'JPG',
        'mov': 'MOV', 'video_preview': 'MOV_预览',
    }

    def add(file_path, media_kind, import_slot):
        directory = os.path.abspath(os.path.dirname(file_path))
        if os.path.commonpath((target_folder, directory)) != target_folder:
            raise ValueError(f'导入产物不属于目标项目：{os.path.basename(file_path)}')
        relative_path = os.path.relpath(directory, target_folder).replace(os.sep, '/')
        if relative_path in ('', '.'):
            raise ValueError(f'导入产物必须位于项目子目录：{os.path.basename(file_path)}')
        key = relative_path.casefold()
        current = artifacts_by_path.get(key)
        if current:
            if current['importSlot'] == 'camera_jpg' and import_slot == 'generated_jpg':
                return
            if current['importSlot'] != import_slot \
                    and not (current['importSlot'] == 'generated_jpg' and import_slot == 'camera_jpg'):
                raise ValueError(f'同一导入目录包含不兼容的产物语义：{relative_path}')
        artifacts_by_path[key] = {
            'relativePath': relative_path,
            'mediaKind': media_kind,
            'importSlot': import_slot,
            'displayName': display_names[import_slot],
        }

    for file_path in imported:
        lowered = file_path.lower()
        if lowered.endswith(CLASSIFY_EXTENSION_MAP['raw']):
            add(file_path, 'image', 'raw')
        elif lowered.endswith(CLASSIFY_EXTENSION_MAP['mov']):
            add(file_path, 'video', 'mov')
        else:
            add(file_path, 'image', 'camera_jpg')
    for file_path in generated_jpg:
        add(file_path, 'image', 'generated_jpg')
    for file_path in generated_preview:
        add(file_path, 'video', 'video_preview')
    return {
        'schemaVersion': 2,
        'projectName': project_name,
        'importSessionId': session_id,
        'artifacts': sorted(artifacts_by_path.values(), key=lambda item: item['relativePath'].casefold()),
    }


def classify_files_by_type(folder_path):
    """整理子文件夹"""
    moved_paths = {}
    for f in os.listdir(folder_path):
        src_path = os.path.join(folder_path, f)
        if not os.path.isfile(src_path) or f.startswith('.'): continue
        f_lower = f.lower()
        for sub, exts in CLASSIFY_EXTENSION_MAP.items():
            if f_lower.endswith(exts):
                sub_dir = os.path.join(folder_path, sub)
                os.makedirs(sub_dir, exist_ok=True)
                # 如果子目录已有同名文件，加时间戳
                dst_path = unique_destination(sub_dir, f)
                shutil.move(src_path, dst_path)
                moved_paths[src_path] = dst_path
                break
    return moved_paths


def find_missing_raw_jpg_candidates(target_folder, imported_paths):
    """Return RAW files from this import that do not have a same-stem JPG."""
    jpg_dir = os.path.join(target_folder, 'jpg')
    jpg_stems = set()
    if os.path.isdir(jpg_dir):
        jpg_stems = {
            os.path.splitext(name)[0].casefold()
            for name in os.listdir(jpg_dir)
            if os.path.isfile(os.path.join(jpg_dir, name)) and name.lower().endswith(JPG_EXTENSIONS)
        }
    candidates = []
    seen = set()
    for file_path in imported_paths:
        normalized = os.path.normcase(os.path.abspath(file_path))
        stem, extension = os.path.splitext(os.path.basename(file_path))
        if extension.lower() not in RAW_EXTENSIONS or stem.casefold() in jpg_stems or normalized in seen:
            continue
        seen.add(normalized)
        jpg_stems.add(stem.casefold())
        candidates.append(file_path)
    return candidates


def generate_raw_jpg(source_path, target_path):
    """Create a full-size JPG from the best embedded preview in a RAW file."""
    image = _embedded_jpeg(source_path)
    temporary = f"{target_path}.tmp-{os.getpid()}"
    try:
        rgb_image = image if image.mode == 'RGB' else image.convert('RGB')
        try:
            rgb_image.save(temporary, format='JPEG', quality=95, optimize=True, progressive=True)
        finally:
            if rgb_image is not image:
                rgb_image.close()
        os.replace(temporary, target_path)
        shutil.copystat(source_path, target_path)
    finally:
        image.close()
        if os.path.exists(temporary):
            os.remove(temporary)


def generate_missing_raw_jpgs(target_folder, imported_paths, converter=generate_raw_jpg, on_progress=None, on_generated=None):
    candidates = find_missing_raw_jpg_candidates(target_folder, imported_paths)
    if not candidates:
        return 0, 0
    jpg_dir = os.path.join(target_folder, 'jpg')
    os.makedirs(jpg_dir, exist_ok=True)
    succeeded = 0
    for index, source_path in enumerate(candidates, start=1):
        ensure_not_cancelled()
        stem = os.path.splitext(os.path.basename(source_path))[0]
        target_path = os.path.join(jpg_dir, f'{stem}.jpg')
        try:
            converter(source_path, target_path)
            succeeded += 1
            if on_generated:
                on_generated(target_path)
        except Exception as error:
            emit('warning', f'无法从 RAW 生成 JPG，已保留 RAW 文件 {os.path.basename(source_path)}：{error}')
        if on_progress:
            on_progress(index, len(candidates), os.path.basename(source_path))
    return succeeded, len(candidates)

def generate_video_previews(target_folder, quality='medium', on_generated=None, source_paths=None):
    """Create H.264 MP4 previews for the already classified video files."""
    quality = normalize_video_preview_quality(quality)
    profile = VIDEO_PREVIEW_QUALITY_PROFILES[quality]
    source_dir = os.path.join(target_folder, 'mov')
    if not os.path.isdir(source_dir):
        return 0, 0

    video_extensions = ('.mp4', '.mov', '.avi', '.crm')
    if source_paths is None:
        video_files = [
            name for name in os.listdir(source_dir)
            if os.path.isfile(os.path.join(source_dir, name)) and name.lower().endswith(video_extensions)
        ]
    else:
        video_files = [
            os.path.basename(file_path) for file_path in source_paths
            if os.path.dirname(os.path.abspath(file_path)) == os.path.abspath(source_dir)
            and os.path.isfile(file_path) and file_path.lower().endswith(video_extensions)
        ]
    if not video_files:
        return 0, 0

    output_dir = os.path.join(target_folder, 'mov_预览')
    os.makedirs(output_dir, exist_ok=True)
    announced_encoder = ''
    succeeded = 0

    log_info(f"正在生成 {len(video_files)} 个{profile['label']}质量视频预览版...")
    for index, file_name in enumerate(video_files, start=1):
        input_path = os.path.join(source_dir, file_name)
        output_name = f"{Path(file_name).stem}.mp4"
        output_path = os.path.join(output_dir, output_name)
        if os.path.exists(output_path):
            output_path = os.path.join(output_dir, f"{Path(file_name).stem}_{int(time.time())}.mp4")

        try:
            used_encoder = transcode_video_preview(input_path, output_path, quality, on_log=log_info)
            succeeded += 1
            if used_encoder and announced_encoder != used_encoder:
                announced_encoder = used_encoder
                log_info(f"视频预览使用{' GPU' if used_encoder != 'libx264' else ' CPU'} 编码器：{used_encoder}")
            if on_generated:
                on_generated(output_path)
            log_info(f"视频预览版 {index}/{len(video_files)}：{os.path.basename(output_path)}")
        except FFmpegTranscodeError as error:
            emit('warning', f"视频预览生成失败，已保留原视频 {file_name}：{error}")

    return succeeded, len(video_files)

def split_large_videos(target_folder, on_split=None, source_paths=None):
    """Losslessly split imported videos for FAT32 and cloud single-file limits."""
    source_dir = os.path.join(target_folder, 'mov')
    if not os.path.isdir(source_dir):
        return 0

    target_size = SPLIT_TARGET_BYTES
    split_count = 0
    file_names = list(os.listdir(source_dir)) if source_paths is None else [
        os.path.basename(file_path) for file_path in source_paths
        if os.path.dirname(os.path.abspath(file_path)) == os.path.abspath(source_dir)
    ]
    large_paths = [os.path.join(source_dir, name) for name in file_names if os.path.isfile(os.path.join(source_dir, name)) and os.path.getsize(os.path.join(source_dir, name)) > target_size]
    ensure_import_disk_space(target_folder, max((os.path.getsize(file_path) for file_path in large_paths), default=0), '大视频分割')
    for file_name in file_names:
        input_path = os.path.join(source_dir, file_name)
        if not os.path.isfile(input_path) or os.path.getsize(input_path) <= target_size:
            continue

        log_info(f'正在将超过 4GB 的视频分割为约 3.95GB：{file_name}')
        try:
            segment_paths = split_video_by_size(
                input_path,
                split_threshold_bytes=target_size,
                target_segment_bytes=target_size,
                maximum_segment_bytes=FOUR_GB,
                cancel_check=ensure_not_cancelled,
            )
            if not segment_paths:
                continue
            if on_split:
                on_split(input_path, segment_paths)
            split_count += 1
            log_info(f'视频分割完成：{file_name} → {len(segment_paths)} 段')
        except FFmpegTranscodeError as error:
            emit('warning', f'视频分割失败，已保留原文件 {file_name}：{error}')
    return split_count


def transcode_imported_videos(target_folder, settings, on_transcoded=None, source_paths=None):
    """Apply the shared video-transcode panel settings to this import batch."""
    source_dir = os.path.join(target_folder, 'mov')
    candidates = [
        os.path.abspath(file_path) for file_path in (source_paths or [])
        if os.path.isfile(file_path)
        and os.path.dirname(os.path.abspath(file_path)) == os.path.abspath(source_dir)
        and os.path.splitext(file_path)[1].lower() in VIDEO_EXTENSIONS
    ]
    succeeded = 0
    outputs = []
    for input_path in candidates:
        ensure_not_cancelled()
        try:
            output_path = transcode_video(
                input_path,
                container=settings.get('container', 'mp4'),
                video_mode=settings.get('videoMode', 'h264'),
                quality=settings.get('quality', 'balanced'),
                resolution=settings.get('resolution', 'original'),
                frame_rate=settings.get('frameRate', 'original'),
                audio_mode=settings.get('audioMode', 'aac'),
                output_mode='new',
                on_log=log_info,
                cancel_check=ensure_not_cancelled,
            )
            succeeded += 1
            outputs.append(output_path)
            if on_transcoded:
                on_transcoded(output_path)
        except (FFmpegTranscodeError, OSError, ValueError) as error:
            emit('warning', f'视频转码失败，已保留原文件 {os.path.basename(input_path)}：{error}')
    return succeeded, len(candidates), outputs
# --- 3. 核心导入流程 ---
def split_broll_video(input_path, keep_original=False):
    """Losslessly split one imported B-roll video and return its new segments."""
    if not os.path.isfile(input_path) or os.path.getsize(input_path) <= FOUR_GB:
        return []
    ensure_not_cancelled()
    log_info(f'正在将超过 4GB 的花絮视频分割为约 3.95GB：{os.path.basename(input_path)}')
    try:
        segments = split_video_by_size(
            input_path,
            split_threshold_bytes=FOUR_GB,
            target_segment_bytes=SPLIT_TARGET_BYTES,
            maximum_segment_bytes=FOUR_GB,
            keep_original=keep_original,
            cancel_check=ensure_not_cancelled,
        )
    except FFmpegTranscodeError as error:
        raise IOError(f'无法安全分割 {os.path.basename(input_path)}：{error}') from error
    log_info(f'花絮视频分割完成：{os.path.basename(input_path)} → {len(segments)} 段')
    return segments


def stage_import_and_organize(sd_path, dest_path, split_threshold_hours=2.0, should_split=None, generate_video_preview=False, split_large_files=False, project_routes=None, direct_project=False, video_preview_quality='medium', direct_source=False, source_paths=None, delete_source=False, generate_jpg_from_raw=False, import_session='', date_filter='all', split_import_videos=False, transcode_import_videos=False, transcode_settings=None):
    # 记录原始文件列表，用于最后的清理
    original_sd_files = []
    success_imported_count = 0
    created_projects = []

    import_session = str(import_session or '').strip() or str(uuid.uuid4())
    try:
        # Step 1-2: 先完整复制到安全暂存区；若规划阶段已完成，则直接复用本地副本。
        staged_import = stage_media_to_safety_temp(sd_path, dest_path, direct_source, source_paths, import_session, progress_end=75, date_filter=date_filter)
        base_sd = staged_import['baseSource']
        original_sd_files = staged_import['originalFiles']
        temp_files_list = staged_import['stagedFiles']
        temp_dir = staged_import['stagingDir']
        total_bytes = staged_import['totalBytes']
        if not original_sd_files:
            log_success(no_staged_media_message(staged_import, direct_source), {'projectNames': [], 'importedCount': 0, 'skipped': True, 'skipReason': 'no-media'})
            return

        route_map = project_routes or {}
        # A fixed project does not need capture-time routing or shooting-gap analysis.
        if direct_project:
            files_with_time = [(file_path, None) for file_path in temp_files_list]
            capture_groups = []
            need_split_check = False
        else:
            files_with_time = staged_files_with_capture_times(staged_import)
            ensure_not_cancelled()
            files_with_time.sort(key=lambda x: x[1])
            # 使用与规划阶段相同的自适应断层结果，避免前后两次分组不一致。
            capture_groups = _build_capture_groups_from_timed_files(files_with_time, split_threshold_hours)
            need_split_check = len(capture_groups) > 1
        
        if not route_map and not direct_project and need_split_check and should_split is None:
            ask_user("根据拍摄时间间隙识别出多个拍摄时段，是否分文件夹整理？", {"need_split": True, "files_count": len(temp_files_list)})
            return

        # Step 4: 移动到最终目的地并分类
        groups = []
        if route_map:
            groups = capture_groups
        elif direct_project:
            groups = [{'id': 'direct', 'files': files_with_time}]
        elif should_split and need_split_check:
            groups = [group['files'] for group in capture_groups]
        else:
            groups = [files_with_time]

        log_info(f"正在整理到目标文件夹...")
        log_progress("正在整理并分类文件...", 75, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": len(original_sd_files), "totalFiles": len(original_sd_files)})
        processed_targets = set()
        imported_paths_by_target = {}
        imported_output_paths = set()
        for idx, group_record in enumerate(groups):
            ensure_not_cancelled()
            group = group_record['files'] if isinstance(group_record, dict) else group_record
            # 命名文件夹
            if route_map:
                target_folder = os.path.abspath(route_map.get(group_record['id'], ''))
                if not target_folder or os.path.commonpath((os.path.abspath(dest_path), target_folder)) != os.path.abspath(dest_path) or not os.path.isdir(target_folder):
                    raise ValueError(f"分组 {group_record['id']} 的目标项目无效，请重新选择")
                date_str = os.path.basename(target_folder)
            elif direct_project:
                target_folder = os.path.abspath(dest_path)
                date_str = os.path.basename(target_folder)
            else:
                first_time = group[0][1]
                date_str = datetime.datetime.fromtimestamp(first_time).strftime('%m-%d').lstrip('0').replace('-0', '-')
                if len(groups) > 1:
                    date_str = f"{date_str}-{idx+1}"
                target_folder = os.path.join(dest_path, date_str)
            os.makedirs(target_folder, exist_ok=True)
            if date_str not in created_projects:
                created_projects.append(date_str)
            
            for f_path, _ in group:
                ensure_not_cancelled()
                entry = staged_entry_for_local_path(staged_import, f_path)
                if entry is None:
                    raise IOError(f'暂存清单缺少文件：{os.path.basename(f_path)}')
                committed_outputs = [os.path.abspath(value) for value in entry.get('outputPaths', []) if os.path.isfile(value)]
                committed_destination = os.path.abspath(str(entry.get('committedDestination') or '')) if entry.get('committedDestination') else ''
                if committed_outputs:
                    imported_paths = committed_outputs
                elif committed_destination and os.path.isfile(committed_destination):
                    imported_paths = [committed_destination]
                else:
                    destination_dir = classified_destination_directory(target_folder, os.path.basename(f_path))
                    os.makedirs(destination_dir, exist_ok=True)
                    pending_destination = str(entry.get('pendingDestination') or '')
                    if pending_destination and os.path.dirname(os.path.abspath(pending_destination)) == os.path.abspath(destination_dir) and not os.path.exists(pending_destination):
                        destination = os.path.abspath(pending_destination)
                    else:
                        destination = unique_destination(destination_dir, os.path.basename(f_path))
                        update_staged_entry(staged_import, entry['staged'], {'pendingDestination': destination})
                    promote_staged_file(f_path, destination)
                    update_staged_entry(staged_import, entry['staged'], {'committedDestination': destination, 'pendingDestination': None})
                    imported_paths = [destination]
                if any(os.path.commonpath((os.path.abspath(target_folder), path)) != os.path.abspath(target_folder) for path in imported_paths):
                    raise ValueError(f'已提交文件与当前项目归属不一致：{os.path.basename(entry["source"])}')
                imported_paths_by_target.setdefault(target_folder, []).extend(imported_paths)
                imported_output_paths.update(imported_paths)
                success_imported_count += 1
            processed_targets.add(target_folder)

            log_progress(
                f"正在整理并分类文件：{idx + 1}/{len(groups)}",
                75 + int(((idx + 1) / max(1, len(groups))) * 15),
                {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)},
            )

        processed_target_list = list(processed_targets)
        generated_jpg_count = 0
        generated_jpg_paths_by_target = {}
        generated_preview_paths_by_target = {}
        raw_without_jpg_count = 0
        if generate_jpg_from_raw:
            all_candidates = [
                (target_folder, source_path)
                for target_folder in processed_target_list
                for source_path in find_missing_raw_jpg_candidates(target_folder, imported_paths_by_target.get(target_folder, []))
            ]
            completed_candidates = 0
            for target_folder in processed_target_list:
                ensure_not_cancelled()
                def publish_raw_jpg_progress(_index, _total, file_name):
                    nonlocal completed_candidates
                    completed_candidates += 1
                    log_progress(
                        f"正在从 RAW 生成 JPG：{file_name}",
                        90 + int((completed_candidates / max(1, len(all_candidates))) * 4),
                        {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)},
                    )

                generated, candidate_count = generate_missing_raw_jpgs(
                    target_folder,
                    imported_paths_by_target.get(target_folder, []),
                    on_progress=publish_raw_jpg_progress,
                    on_generated=lambda generated_path, target=target_folder: (
                        imported_output_paths.add(generated_path),
                        generated_jpg_paths_by_target.setdefault(target, []).append(generated_path),
                    ),
                )
                generated_jpg_count += generated
                raw_without_jpg_count += candidate_count
            if raw_without_jpg_count:
                log_info(f"RAW 转 JPG 完成：{generated_jpg_count}/{raw_without_jpg_count} 个文件已保存到 jpg 文件夹")
        for target_index, target_folder in enumerate(processed_target_list):
            ensure_not_cancelled()
            if split_large_files or split_import_videos:
                def record_split_output(input_path, segment_paths):
                    imported_output_paths.discard(input_path)
                    imported_output_paths.update(segment_paths)
                    target_paths = imported_paths_by_target.get(target_folder, [])
                    imported_paths_by_target[target_folder] = [path for path in target_paths if path != input_path] + list(segment_paths)
                    entry = staged_entry_for_local_path(staged_import, input_path)
                    if entry:
                        update_staged_entry(staged_import, entry['staged'], {'outputPaths': list(segment_paths)})

                split_count = split_large_videos(
                    target_folder,
                    on_split=record_split_output,
                    source_paths=imported_paths_by_target.get(target_folder, []),
                )
                if split_count:
                    log_info(f'大文件分割完成：共处理 {split_count} 个视频')
            if transcode_import_videos:
                transcode_count, video_count, transcode_outputs = transcode_imported_videos(
                    target_folder,
                    transcode_settings or {},
                    on_transcoded=lambda output_path: imported_output_paths.add(output_path),
                    source_paths=imported_paths_by_target.get(target_folder, []),
                )
                imported_paths_by_target.setdefault(target_folder, []).extend(transcode_outputs)
                if video_count:
                    log_info(f'视频转码完成：{transcode_count}/{video_count} 个文件')
            if generate_video_preview:
                def record_generated_preview(generated_path, target=target_folder):
                    imported_output_paths.add(generated_path)
                    generated_preview_paths_by_target.setdefault(target, []).append(generated_path)

                preview_count, video_count = generate_video_previews(
                    target_folder,
                    video_preview_quality,
                    on_generated=record_generated_preview,
                    source_paths=imported_paths_by_target.get(target_folder, []),
                )
                if video_count:
                    log_info(f"视频预览完成：{preview_count}/{video_count} 个文件已保存到 mov_预览")
            log_progress(
                f"正在完成导入后处理：{target_index + 1}/{len(processed_target_list)}",
                94 + int(((target_index + 1) / max(1, len(processed_target_list))) * 2),
                {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)},
            )
        # Step 5: 最终校验与清理 SD 卡
        if success_imported_count == len(original_sd_files):
            log_info(f"整理完成，共处理 {success_imported_count} 个文件")
            import_manifests = [
                build_import_graph_manifest(
                    dest_path, target_folder, os.path.basename(target_folder), import_session,
                    imported_paths_by_target.get(target_folder, []),
                    generated_jpg_paths_by_target.get(target_folder, []),
                    generated_preview_paths_by_target.get(target_folder, []),
                )
                for target_folder in sorted(processed_target_list)
            ]
            write_import_graph_receipt(temp_dir, import_session, import_manifests)
            
            deleted_source_count = 0
            should_delete_sources = False
            if delete_source:
                source_cleanup_allowed = source_files_are_safe_to_delete(staged_import)
                if source_cleanup_allowed:
                    log_info("正在安全清理导入源文件...")
                    for cleanup_index, f in enumerate(original_sd_files):
                        ensure_not_cancelled()
                        try:
                            os.remove(f)
                            deleted_source_count += 1
                        except OSError:
                            pass
                        log_progress(
                            f"正在完成源文件清理：{cleanup_index + 1}/{len(original_sd_files)}",
                            96 + int(((cleanup_index + 1) / max(1, len(original_sd_files))) * 3),
                            {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)},
                        )
                else:
                    emit('warning', '源设备已断开、已经更换或文件发生变化；为避免误删，本次不会清理任何源文件。')
                should_delete_sources = deleted_source_count == len(original_sd_files)
                if source_cleanup_allowed and not should_delete_sources:
                    emit('warning', f'导入已完成，但源设备不可用或部分源文件无法删除；已删除 {deleted_source_count}/{len(original_sd_files)} 个源文件。')
            else:
                log_progress("正在保留源文件...", 99, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)})
            
            log_progress("导入流程全部完成", 100, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": success_imported_count, "totalFiles": len(original_sd_files)})
            log_success("导入完成，源文件已按设置处理", {"projectNames": created_projects, "importedCount": success_imported_count, "sourceFilesDeleted": should_delete_sources, "generatedJpgCount": generated_jpg_count, "importedPaths": sorted(imported_output_paths), "importSessionId": import_session, "importManifests": import_manifests, "receiptPending": True})
        else:
            log_error(f"警告：导入数量不匹配（应有{len(original_sd_files)}，实际{success_imported_count}）。SD 卡未清理，请检查桌面临时文件夹。")

    except ImportCancelled:
        emit('cancelled', '导入已取消；源文件未删除，已完成的目标文件已保留。')
        gc.collect()
    except Exception as e:
        log_error(f"流程异常: {str(e)}")
        # 异常情况下保留临时文件夹和 SD 卡文件，确保数据不丢
        gc.collect()

def stage_import_broll(sd_path, dest_path, project_routes=None, direct_source=False, source_paths=None, delete_source=False, split_large_files=False, import_session='', date_filter='all', split_import_videos=False, transcode_import_videos=False, transcode_settings=None):
    """Promote staged media into each selected project's B-roll folder."""
    created_files = []
    created_broll_folders = []
    moved_staged_files = {}
    split_originals = []
    source_cleanup_started = False
    deleted_source_count = 0

    try:
        staged_import = stage_media_to_safety_temp(sd_path, dest_path, direct_source, source_paths, import_session, progress_end=75, date_filter=date_filter)
        base_sd = staged_import['baseSource']
        original_files = staged_import['originalFiles']
        import_files = staged_import['stagedFiles']
        staging_dir = staged_import['stagingDir']
        if not original_files:
            log_success(no_staged_media_message(staged_import, direct_source), {'projectNames': [], 'importedCount': 0, 'skipped': True, 'skipReason': 'no-media'})
            return

        if not dest_path or not os.path.isdir(dest_path):
            log_error("花絮目标项目不存在，请重新选择项目")
            return
        route_map = project_routes or {}
        file_routes = {}
        if route_map:
            timed_files = staged_files_with_capture_times(staged_import)
            for group in _build_capture_groups_from_timed_files(timed_files):
                project_path = os.path.abspath(route_map.get(group['id'], ''))
                if not project_path or os.path.commonpath((os.path.abspath(dest_path), project_path)) != os.path.abspath(dest_path) or not os.path.isdir(project_path):
                    raise ValueError(f"分组 {group['id']} 的目标项目无效，请重新选择")
                for file_path, _timestamp in group['files']:
                    file_routes[file_path] = project_path
        total_bytes = staged_import['totalBytes']
        log_progress("素材导入完成，准备整理花絮...", 75, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": 0, "totalFiles": len(import_files)})
        completed_bytes = 0
        last_progress_at = 0.0
        log_info(f"正在把 {len(import_files)} 个已导入文件整理到花絮...")
        for index, source in enumerate(import_files):
            ensure_not_cancelled()
            project_path = file_routes.get(source, dest_path)
            broll_folder = os.path.join(project_path, '花絮')
            if not os.path.isdir(broll_folder):
                os.makedirs(broll_folder, exist_ok=False)
                created_broll_folders.append(broll_folder)
            source_size = os.path.getsize(source)
            will_split = (split_large_files or split_import_videos) and os.path.splitext(source)[1].lower() in VIDEO_EXTENSIONS and source_size > FOUR_GB
            if will_split:
                ensure_import_disk_space(project_path, source_size, '花絮视频分割')
            destination = unique_broll_destination(broll_folder, os.path.basename(source), will_split)

            def publish_broll_progress(current_file_bytes, force=False):
                nonlocal last_progress_at
                now = time.monotonic()
                bytes_copied = min(total_bytes, completed_bytes + current_file_bytes)
                if not force and now - last_progress_at < 0.1 and bytes_copied < total_bytes:
                    return
                last_progress_at = now
                log_progress(
                    f"导入花絮：{os.path.basename(source)}",
                    75 + int((bytes_copied / max(1, total_bytes)) * 15),
                    {
                        "bytesCopied": total_bytes,
                        "totalBytes": total_bytes,
                        "bytesPerSecond": 0,
                        "filesCopied": index + (1 if force else 0),
                        "totalFiles": len(original_files),
                        "phase": "organizing",
                    },
                )

            try:
                moved_from_staging = promote_staged_file(
                    source,
                    destination,
                    on_progress=publish_broll_progress,
                    allow_atomic_move=True,
                )
            except Exception:
                try:
                    os.remove(destination)
                except OSError:
                    pass
                raise
            if os.path.getsize(destination) != source_size:
                try:
                    os.remove(destination)
                except OSError:
                    pass
                raise IOError(f"整理校验失败：{os.path.basename(source)}")
            created_files.append(destination)
            if moved_from_staging:
                moved_staged_files[destination] = source
            post_process_video_paths = [destination]
            if will_split:
                log_progress(
                    f"正在分割花絮大视频：{os.path.basename(destination)}",
                    75 + int(((completed_bytes + source_size) / max(1, total_bytes)) * 15),
                    {"bytesCopied": total_bytes, "totalBytes": total_bytes, "bytesPerSecond": 0, "filesCopied": index, "totalFiles": len(original_files), "phase": "splitting"},
                )
                segments = split_broll_video(destination, keep_original=True)
                if segments:
                    created_files.remove(destination)
                    created_files.extend(segments)
                    split_originals.append(destination)
                    post_process_video_paths = segments
            if transcode_import_videos:
                for video_path in post_process_video_paths:
                    if os.path.splitext(video_path)[1].lower() not in VIDEO_EXTENSIONS:
                        continue
                    try:
                        output_path = transcode_video(
                            video_path,
                            container=(transcode_settings or {}).get('container', 'mp4'),
                            video_mode=(transcode_settings or {}).get('videoMode', 'h264'),
                            quality=(transcode_settings or {}).get('quality', 'balanced'),
                            resolution=(transcode_settings or {}).get('resolution', 'original'),
                            frame_rate=(transcode_settings or {}).get('frameRate', 'original'),
                            audio_mode=(transcode_settings or {}).get('audioMode', 'aac'),
                            output_mode='new',
                            on_log=log_info,
                            cancel_check=ensure_not_cancelled,
                        )
                        created_files.append(output_path)
                    except (FFmpegTranscodeError, OSError, ValueError) as error:
                        emit('warning', f'花絮视频转码失败，已保留原文件 {os.path.basename(video_path)}：{error}')
            completed_bytes += source_size
            publish_broll_progress(0, True)

        # All segments are complete before their full-size inputs are removed.
        # From this point onward target files are the durable local copies.
        if split_originals:
            source_cleanup_started = True
            for original in split_originals:
                os.remove(original)

        # The source card is only cleaned after every destination file has passed validation.
        should_delete_sources = False
        if delete_source:
            source_cleanup_allowed = source_files_are_safe_to_delete(staged_import)
            if source_cleanup_allowed:
                source_cleanup_started = True
                for cleanup_index, source in enumerate(original_files):
                    ensure_not_cancelled()
                    try:
                        os.remove(source)
                        deleted_source_count += 1
                    except OSError:
                        pass
                    log_progress(
                        f"正在完成花絮源文件清理：{cleanup_index + 1}/{len(original_files)}",
                        90 + int(((cleanup_index + 1) / max(1, len(original_files))) * 9),
                        {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": len(original_files), "totalFiles": len(original_files)},
                    )
            else:
                emit('warning', '源设备已断开、已经更换或文件发生变化；为避免误删，本次不会清理任何源文件。')
            should_delete_sources = deleted_source_count == len(original_files)
            if source_cleanup_allowed and not should_delete_sources:
                emit('warning', f'花絮导入已完成，但源设备不可用或部分源文件无法删除；已删除 {deleted_source_count}/{len(original_files)} 个源文件。')
        else:
            log_progress("正在保留源文件...", 99, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": len(original_files), "totalFiles": len(original_files)})
        cleanup_import_staging(staging_dir)
        log_progress("花絮导入流程全部完成", 100, {"bytesCopied": total_bytes, "totalBytes": total_bytes, "filesCopied": len(original_files), "totalFiles": len(original_files)})
        log_success("花絮导入完成，源文件已按设置处理", {
            "projectNames": sorted({os.path.basename(os.path.normpath(project_path)) for project_path in (file_routes.values() or [dest_path])}),
            "importedCount": len(original_files),
            "destination": dest_path,
            "brollFolders": sorted({os.path.dirname(file_path) for file_path in created_files}),
            "sourceFilesDeleted": should_delete_sources,
            "importedPaths": sorted(created_files),
        })
    except Exception as error:
        # Before source cleanup starts, remove a partial destination so retrying
        # is unambiguous. Once cleanup has begun, destination copies are the
        # only remaining copy for any source already deleted and must be kept.
        if not source_cleanup_started:
            for original in split_originals:
                staged_source = moved_staged_files.get(original)
                if staged_source and os.path.exists(original) and not os.path.exists(staged_source):
                    try:
                        os.replace(original, staged_source)
                    except OSError:
                        pass
            for destination in created_files:
                staged_source = moved_staged_files.get(destination)
                if staged_source and os.path.exists(destination) and not os.path.exists(staged_source):
                    try:
                        os.replace(destination, staged_source)
                        continue
                    except OSError:
                        # Keep the destination when rollback cannot restore the
                        # staged path; deleting it could remove the only local copy.
                        continue
                try:
                    os.remove(destination)
                except OSError:
                    pass
            for directory in reversed(created_broll_folders):
                try:
                    os.rmdir(directory)
                except OSError:
                    pass
            if isinstance(error, ImportCancelled):
                emit('cancelled', '花絮导入已取消；本次新增目标已回滚，源文件未删除。')
            else:
                log_error(f"花絮导入失败，SD 卡原文件已保留：{error}")
        elif isinstance(error, ImportCancelled):
            emit('cancelled', f'花絮导入已取消；已停止继续清理源文件，已删除 {deleted_source_count}/{len(original_files)} 个源文件，目标文件均已保留。')
        else:
            log_error(f"花絮文件已完整复制，但清理 SD 卡时失败；目标文件已保留，请手动检查卡内剩余文件：{error}")
        gc.collect()


def discard_import_session(dest_path, import_session):
    staging_dir = get_import_staging_dir(dest_path, import_session)
    cleanup_import_staging(staging_dir)
    log_success('已丢弃本次导入暂存', {'discarded': True})

def run(args_list):
    if sys.platform.startswith('win'):
        if sys.stdout: sys.stdout.reconfigure(encoding='utf-8')
        if sys.stderr: sys.stderr.reconfigure(encoding='utf-8')
        
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True)
    parser.add_argument("--sd_path", default="")
    parser.add_argument("--dest_path", default="")
    parser.add_argument("--time_gap", type=float, default=2.0)
    parser.add_argument("--should_split", type=str, default="")
    parser.add_argument("--generate_video_preview", action="store_true")
    parser.add_argument("--video_preview_quality", choices=tuple(VIDEO_PREVIEW_QUALITY_PROFILES), default="medium")
    parser.add_argument("--split_large_files", action="store_true")
    parser.add_argument("--split_import_videos", action="store_true")
    parser.add_argument("--transcode_import_videos", action="store_true")
    parser.add_argument("--transcode_settings", default="{}")
    parser.add_argument("--projects_json", default="[]")
    parser.add_argument("--project_routes", default="{}")
    parser.add_argument("--import_type", choices=("work", "broll"), default="work")
    parser.add_argument("--direct_project", action="store_true")
    parser.add_argument("--direct_source", action="store_true")
    parser.add_argument("--source_paths", default="[]")
    parser.add_argument("--delete_source", action="store_true")
    parser.add_argument("--generate_jpg_from_raw", action="store_true")
    parser.add_argument("--import_session", default="")
    parser.add_argument("--date_filter", choices=IMPORT_DATE_FILTERS, default="all")
    parser.add_argument("--exiftool_path", default="")
    parser.add_argument("--cancel_file", default="")

    args, _ = parser.parse_known_args(args_list)
    global CANCEL_FILE, EXIFTOOL_PATH
    CANCEL_FILE = os.path.abspath(args.cancel_file) if args.cancel_file else ''
    EXIFTOOL_PATH = os.path.abspath(args.exiftool_path) if args.exiftool_path else ''
    try:
        source_paths = [str(value) for value in json.loads(args.source_paths or '[]') if str(value).strip()]
    except (TypeError, ValueError, json.JSONDecodeError):
        source_paths = []
    
    split_val = None
    if args.should_split.lower() == 'true': split_val = True
    elif args.should_split.lower() == 'false': split_val = False

    try:
        if args.stage == 'check':
            log_status("SD Card Detected" if os.path.exists(args.sd_path) else "No Device", {"connected": os.path.exists(args.sd_path), "path": args.sd_path})
        elif args.stage == 'plan':
            stage_plan_import(args.sd_path, args.dest_path, args.projects_json, args.import_type, args.time_gap, args.direct_source, source_paths, args.import_session, args.date_filter)
        elif args.stage == 'import':
            stage_import_and_organize(args.sd_path, args.dest_path, args.time_gap, split_val, args.generate_video_preview, args.split_large_files, json.loads(args.project_routes or '{}'), args.direct_project, args.video_preview_quality, args.direct_source, source_paths, args.delete_source, args.generate_jpg_from_raw, args.import_session, args.date_filter, args.split_import_videos, args.transcode_import_videos, json.loads(args.transcode_settings or '{}'))
        elif args.stage == 'broll':
            stage_import_broll(args.sd_path, args.dest_path, json.loads(args.project_routes or '{}'), args.direct_source, source_paths, args.delete_source, args.split_large_files, args.import_session, args.date_filter, args.split_import_videos, args.transcode_import_videos, json.loads(args.transcode_settings or '{}'))
        elif args.stage == 'discard':
            discard_import_session(args.dest_path, args.import_session)
    except ImportCancelled:
        emit('cancelled', '素材分析已取消' if args.stage == 'plan' else '导入已取消')

if __name__ == "__main__":
    run(sys.argv[1:])
