import importlib
import os
import shutil
import sys
import tempfile
import uuid
import zipfile


def get_ffmpeg_exe():
    """返回开发环境或应用资源目录中的共享 FFmpeg。"""
    executable_name = "ffmpeg.exe" if sys.platform.startswith("win") else "ffmpeg"

    if getattr(sys, "frozen", False):
        archive_path = os.path.join(os.path.dirname(sys.executable), "ffmpeg.zip")
        if not os.path.isfile(archive_path):
            raise RuntimeError(f"未找到应用内置的 FFmpeg：{archive_path}")

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

    # 仅在开发环境动态导入，避免 PyInstaller 将 imageio-ffmpeg 的二进制文件
    # 分别塞进每个工具的单文件包。
    imageio_ffmpeg = importlib.import_module("imageio_ffmpeg")
    return imageio_ffmpeg.get_ffmpeg_exe()
