import os
import sys
import json
import argparse
from io import BytesIO
from PIL import Image, ImageCms
from send2trash import send2trash


# 所有输出统一为 sRGB；这是网页和大多数 Windows 软件的默认色彩空间。
_SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
_SRGB_ICC_PROFILE = _SRGB_PROFILE.tobytes()

# --- Electron 通信辅助函数 ---
def emit(event_type, message, data=None, progress=None):
    payload = {"type": event_type, "message": message}
    if data is not None: payload["data"] = data
    if progress is not None: payload["progress"] = progress
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def log_info(msg): emit('log', msg)
def log_success(msg): emit('success', msg)
def log_error(msg): emit('error', msg)
def log_progress(msg, percent): emit('progress', msg, progress=percent)


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
    parser.add_argument("path", nargs='?', help="要处理的目录路径")
    parser.add_argument("--quality", type=int, default=100)
    args = parser.parse_args(args_list)

    # 获取路径
    directory = args.path
    
    if not directory:
        log_error("未提供目录路径")
        return

    # 清理路径引号
    directory = directory.strip('"')

    if not os.path.exists(directory):
        log_error(f"错误：目录 '{directory}' 不存在。")
        return

    # 扫描 PNG 文件
    try:
        all_files = os.listdir(directory)
    except Exception as e:
        log_error(f"无法读取目录: {str(e)}")
        return

    # 不只看扩展名：部分素材虽然以 .jpg 命名，内容实际上是 PNG。
    png_files = []
    for filename in all_files:
        file_path = os.path.join(directory, filename)
        if not os.path.isfile(file_path):
            continue
        try:
            with open(file_path, 'rb') as source:
                is_png = source.read(8) == b'\x89PNG\r\n\x1a\n'
            if is_png:
                png_files.append(filename)
        except OSError:
            continue
    total_files = len(png_files)

    if total_files == 0:
        log_success(f"在 '{directory}' 中未发现 PNG 文件。")
        return

    log_info(f"找到 {total_files} 个 PNG 文件，准备开始转换...")
    
    success_count = 0
    
    for index, filename in enumerate(png_files):
        file_path = os.path.join(directory, filename)
        
        try:
            with Image.open(file_path) as img:
                rgb_img = convert_to_srgb(img)
                jpg_filename = os.path.splitext(filename)[0] + '.jpg'
                jpg_file_path = os.path.join(directory, jpg_filename)
                
                rgb_img.save(
                    jpg_file_path,
                    'JPEG',
                    quality=max(1, min(100, args.quality)),
                    icc_profile=_SRGB_ICC_PROFILE,
                )
                
                # 移入回收站
                send2trash(file_path)
                
                success_count += 1
                
                # 计算进度
                percent = int(((index + 1) / total_files) * 100)
                log_progress(f"转换完成: {filename} -> {jpg_filename}", percent)
                
        except Exception as e:
            log_error(f"转换失败 '{filename}': {str(e)}")

    emit('success', f"处理完成！成功转换 {success_count}/{total_files} 个文件。")

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")
