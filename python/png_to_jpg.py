import os
import sys
import argparse
from io import BytesIO
from event_protocol import log_error, log_info, log_progress, log_success
from PIL import Image, ImageCms
from send2trash import send2trash


# 所有输出统一为 sRGB；这是网页和大多数 Windows 软件的默认色彩空间。
_SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
_SRGB_ICC_PROFILE = _SRGB_PROFILE.tobytes()

def convert_to_srgb(img):
    """将带 ICC 配置文件的图片转换为 sRGB，其他图片按 sRGB 处理。"""
    source_icc_profile = img.info.get("icc_profile")
    if not source_icc_profile:
        return img.convert("RGB")

    try:
        source_profile = ImageCms.ImageCmsProfile(BytesIO(source_icc_profile))
        return ImageCms.profileToProfile(
            img, source_profile, _SRGB_PROFILE, outputMode="RGB"
        )
    except (ImageCms.PyCMSError, OSError, ValueError):
        # 配置文件损坏时保持原先的兼容行为，避免一张异常图片中断整个批处理。
        return img.convert("RGB")

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

    # 不只看扩展名：部分素材虽然以 .jpg 命名，内容实际上是 PNG。
    png_files = []
    seen_paths = set()
    for file_path in candidate_files:
        normalized_path = os.path.normcase(os.path.abspath(file_path))
        if normalized_path in seen_paths or not os.path.isfile(file_path):
            continue
        seen_paths.add(normalized_path)
        try:
            with open(file_path, 'rb') as source:
                is_png = source.read(8) == b'\x89PNG\r\n\x1a\n'
            if is_png:
                png_files.append(file_path)
        except OSError:
            continue
    total_files = len(png_files)

    if total_files == 0:
        log_success("所选文件或文件夹中未发现 PNG 文件。")
        return

    log_info(f"找到 {total_files} 个 PNG 文件，准备开始转换...")
    
    success_count = 0
    
    for index, file_path in enumerate(png_files):
        filename = os.path.basename(file_path)
        try:
            with Image.open(file_path) as img:
                rgb_img = convert_to_srgb(img)
                jpg_filename = os.path.splitext(filename)[0] + '.jpg'
                jpg_file_path = os.path.join(os.path.dirname(file_path), jpg_filename)
                
                rgb_img.save(
                    jpg_file_path,
                    'JPEG',
                    quality=max(1, min(100, args.quality)),
                    icc_profile=_SRGB_ICC_PROFILE,
                )
                
                if not args.keep_original:
                    # 只有 JPG 成功写入后才处理原文件。
                    send2trash(file_path)
                
                success_count += 1
                
                # 计算进度
                percent = int(((index + 1) / total_files) * 100)
                log_progress(f"转换完成: {filename} -> {jpg_filename}", percent)
                
        except Exception as e:
            log_error(f"转换失败 '{filename}': {str(e)}")

    log_success(f"处理完成！成功转换 {success_count}/{total_files} 个文件。")

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")
