import importlib
import os
import sys
import tempfile
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
        if not os.path.isfile(extracted_ffmpeg):
            os.makedirs(cache_dir, exist_ok=True)
            with zipfile.ZipFile(archive_path) as archive:
                with archive.open(executable_name) as source, open(extracted_ffmpeg, "wb") as target:
                    target.write(source.read())
            if not sys.platform.startswith("win"):
                os.chmod(extracted_ffmpeg, 0o755)
        return extracted_ffmpeg

    # 仅在开发环境动态导入，避免 PyInstaller 将 imageio-ffmpeg 的二进制文件
    # 分别塞进每个工具的单文件包。
    imageio_ffmpeg = importlib.import_module("imageio_ffmpeg")
    return imageio_ffmpeg.get_ffmpeg_exe()
