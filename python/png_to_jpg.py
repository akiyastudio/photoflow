import os
import sys
import argparse
import uuid
from io import BytesIO
from pathlib import Path
from event_protocol import log_error, log_info, log_progress, log_success
from PIL import Image, ImageCms, ImageOps
from send2trash import send2trash


CONVERTIBLE_EXTENSIONS = {
    ".png", ".webp", ".heic", ".heif", ".hif", ".avif",
    ".tif", ".tiff", ".bmp", ".gif",
}
CONVERTIBLE_FORMATS = {"PNG", "WEBP", "HEIF", "AVIF", "TIFF", "BMP", "GIF"}

try:
    from pi_heif import register_heif_opener
except ImportError:
    register_heif_opener = None
else:
    register_heif_opener(thumbnails=False)


# 所有输出统一为 sRGB；这是网页和大多数 Windows 软件的默认色彩空间。
_SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
_SRGB_ICC_PROFILE = _SRGB_PROFILE.tobytes()


def flatten_transparency(img):
    """将透明像素合成到白色背景，避免 JPEG 中出现黑底。"""
    if "A" not in img.getbands() and "transparency" not in img.info:
        return img
    rgba = img.convert("RGBA")
    try:
        background = Image.new("RGBA", rgba.size, "white")
        try:
            background.alpha_composite(rgba)
            return background.convert("RGB")
        finally:
            background.close()
    finally:
        rgba.close()


def convert_to_srgb(img):
    """将带 ICC 配置文件的图片转换为 sRGB，其他图片按 sRGB 处理。"""
    source_icc_profile = img.info.get("icc_profile")
    flattened = flatten_transparency(img)
    try:
        if not source_icc_profile:
            return flattened.convert("RGB")
        source_profile = ImageCms.ImageCmsProfile(BytesIO(source_icc_profile))
        return ImageCms.profileToProfile(
            flattened, source_profile, _SRGB_PROFILE, outputMode="RGB"
        )
    except (ImageCms.PyCMSError, OSError, ValueError):
        # 配置文件损坏时保持原先的兼容行为，避免一张异常图片中断整个批处理。
        return flattened.convert("RGB")
    finally:
        if flattened is not img:
            flattened.close()


def has_convertible_signature(file_path):
    """兼容扩展名错误的常见图片，同时避免对目录中的每个文件做完整解码。"""
    try:
        with open(file_path, "rb") as source:
            header = source.read(16)
    except OSError:
        return False
    if header.startswith((b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a", b"BM", b"II*\x00", b"MM\x00*")):
        return True
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return True
    return len(header) >= 12 and header[4:8] == b"ftyp" and header[8:12] in {
        b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis",
        b"mif1", b"msf1", b"avif", b"avis",
    }


def is_conversion_candidate(file_path):
    return Path(file_path).suffix.lower() in CONVERTIBLE_EXTENSIONS or has_convertible_signature(file_path)


def unique_jpg_path(file_path):
    source = Path(file_path)
    preferred = source.with_suffix(".jpg")
    if not preferred.exists():
        return preferred
    fallback = source.with_name(f"{source.stem}_转换.jpg")
    if not fallback.exists():
        return fallback
    index = 2
    while True:
        candidate = source.with_name(f"{source.stem}_转换_{index}.jpg")
        if not candidate.exists():
            return candidate
        index += 1


def save_verified_jpeg(image, target, quality):
    temporary = target.with_name(f".{target.name}.photoflow-{uuid.uuid4().hex}.tmp")
    try:
        image.save(
            temporary,
            "JPEG",
            quality=max(1, min(100, quality)),
            icc_profile=_SRGB_ICC_PROFILE,
        )
        with Image.open(temporary) as verification:
            verification.load()
            if verification.format != "JPEG":
                raise OSError("生成文件未通过 JPG 格式验证")
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()

def run(args_list):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs='+', help="要处理的文件或目录路径")
    parser.add_argument("--quality", type=int, default=100)
    parser.add_argument("--keep-original", action="store_true")
    args = parser.parse_args(args_list)

    # 扫描所选文件以及所选目录的全部子目录。路径可能同时包含父目录、
    # 子目录和其中的文件，因此稍后以规范化绝对路径去重。
    candidate_files = []
    for raw_path in args.paths:
        target_path = raw_path.strip('"')
        if os.path.isfile(target_path):
            candidate_files.append(target_path)
            continue
        if os.path.isdir(target_path):
            try:
                for directory, directory_names, file_names in os.walk(target_path):
                    directory_names[:] = [
                        name for name in directory_names
                        if not os.path.islink(os.path.join(directory, name))
                    ]
                    candidate_files.extend(os.path.join(directory, name) for name in file_names)
            except OSError as error:
                log_error(f"无法读取目录 '{target_path}': {str(error)}")
                return
            continue
        log_error(f"路径不存在：'{target_path}'")
        return

    # 不只看扩展名：部分素材扩展名错误，但内容仍是受支持的图片格式。
    image_files = []
    seen_paths = set()
    for file_path in candidate_files:
        normalized_path = os.path.normcase(os.path.abspath(file_path))
        if normalized_path in seen_paths or not os.path.isfile(file_path):
            continue
        seen_paths.add(normalized_path)
        if is_conversion_candidate(file_path):
            image_files.append(file_path)
    total_files = len(image_files)

    if total_files == 0:
        log_success("所选文件或文件夹中未发现可转换的图片。")
        return

    log_info(f"找到 {total_files} 个可转换图片，准备开始转换...")
    
    success_count = 0
    
    for index, file_path in enumerate(image_files):
        filename = os.path.basename(file_path)
        try:
            with Image.open(file_path) as img:
                img.seek(0)
                if img.format not in CONVERTIBLE_FORMATS:
                    raise ValueError(f"不支持的图片格式：{img.format or '未知'}")
                oriented = ImageOps.exif_transpose(img)
                rgb_img = convert_to_srgb(oriented)
                try:
                    jpg_file_path = unique_jpg_path(file_path)
                    save_verified_jpeg(rgb_img, jpg_file_path, args.quality)
                finally:
                    if rgb_img is not oriented:
                        rgb_img.close()
                    if oriented is not img:
                        oriented.close()

            if not args.keep_original:
                # 只有 JPG 成功写入并通过解码验证后才处理原文件。
                send2trash(file_path)

            success_count += 1

            percent = int(((index + 1) / total_files) * 100)
            log_progress(f"转换完成: {filename} -> {jpg_file_path.name}", percent)
                
        except Exception as e:
            log_error(f"转换失败 '{filename}': {str(e)}")

    log_success(f"处理完成！成功转换 {success_count}/{total_files} 个文件。")

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")
