import os
import shutil
import sys
import tempfile
import uuid
import zipfile


def _ffmpeg_archive_candidates():
    if getattr(sys, "frozen", False):
        executable_dir = os.path.dirname(sys.executable)
        return [
            os.path.join(executable_dir, "ffmpeg.zip"),
            os.path.join(os.path.dirname(executable_dir), "ffmpeg.zip"),
        ]

    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return [os.path.join(project_root, "artifacts", "python", "ffmpeg.zip")]


def get_ffmpeg_exe():
    """返回开发环境或应用资源目录中的共享 FFmpeg。"""
    executable_name = "ffmpeg.exe" if sys.platform.startswith("win") else "ffmpeg"
    archive_candidates = _ffmpeg_archive_candidates()
    archive_path = next((candidate for candidate in archive_candidates if os.path.isfile(candidate)), None)
    if archive_path is None:
        environment = "应用内置" if getattr(sys, "frozen", False) else "开发环境"
        raise RuntimeError(f"未找到{environment}的 FFmpeg：{'；'.join(archive_candidates)}")

    archive_stat = os.stat(archive_path)
    cache_dir = os.path.join(
        tempfile.gettempdir(),
        "photoflow",
        "ffmpeg",
        f"{archive_stat.st_size}-{archive_stat.st_mtime_ns}",
    )
    extracted_ffmpeg = os.path.join(cache_dir, executable_name)
    os.makedirs(cache_dir, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        expected_size = archive.getinfo(executable_name).file_size
        extracted_size = os.path.getsize(extracted_ffmpeg) if os.path.isfile(extracted_ffmpeg) else -1
        if extracted_size != expected_size:
            temporary = f"{extracted_ffmpeg}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
            try:
                with archive.open(executable_name) as source, open(temporary, "wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                # Multiple preview workers can start together. Only expose
                # a complete executable and tolerate another worker winning
                # the race while this process was extracting its copy.
                current_size = os.path.getsize(extracted_ffmpeg) if os.path.isfile(extracted_ffmpeg) else -1
                if current_size != expected_size:
                    try:
                        os.replace(temporary, extracted_ffmpeg)
                    except PermissionError:
                        if not os.path.isfile(extracted_ffmpeg) or os.path.getsize(extracted_ffmpeg) != expected_size:
                            raise
                if not sys.platform.startswith("win"):
                    os.chmod(extracted_ffmpeg, 0o755)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    return extracted_ffmpeg
