import os
import re
import sys
import json
import argparse
import subprocess
from ffmpeg_utils import get_ffmpeg_exe

# 向 Electron 前端发送事件的辅助函数
def emit(event_type, message, progress=None):
    data = {"type": event_type, "message": message}
    if progress is not None:
        data["progress"] = progress
    print(json.dumps(data), flush=True)

def fast_lossless_split(input_file):
    if not os.path.exists(input_file):
        emit("error", f"❌ 找不到文件: {input_file}")
        return
        
    emit("progress", f"正在分析视频: {os.path.basename(input_file)} ...", 10)
    
    ffmpeg_exe = get_ffmpeg_exe()
    
    # 1. 尝试读取视频的总时长
    cmd_info = [ffmpeg_exe, "-i", input_file]
    result = subprocess.run(cmd_info, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='ignore')
    output = result.stderr
    
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", output)
    if not match:
        emit("error", "❌ 无法读取视频时长，请检查文件是否为合法视频。")
        return
        
    h, m, s = match.groups()
    total_seconds = int(h) * 3600 + int(m) * 60 + float(s)
    
    # --- 以下为修改后的 4GB 切割逻辑 ---
    file_size = os.path.getsize(input_file)
    target_size = 3.95 * 1024 * 1024 * 1024 # 设为 3.95GB 留点安全余量
    
    if file_size <= target_size:
        emit("success", "✅ 视频文件小于 4GB，无需切割！", 100)
        return

    # 按比例估算 4GB 对应的视频时长（假设视频码率大致均匀）
    segment_duration = total_seconds * (target_size / file_size)
    part_count = int((file_size + target_size - 1) // target_size) # 向上取整计算预估段数
    
    emit("log", f"视频时长: {total_seconds:.2f} 秒，大小: {file_size/(1024**3):.2f} GB")
    emit("log", f"目标单文件大小: 约 3.95 GB，预估切割为 {part_count} 段，每段约 {segment_duration:.2f} 秒")
    
    file_name, file_ext = os.path.splitext(input_file)
    # 生成如 "视频_part001.mp4", "视频_part002.mp4" 的输出格式
    output_pattern = f"{file_name}_part%03d{file_ext}"
    
    emit("progress", f"⚡ 正在切割，请耐心等待...", 50)
    
    # 使用 ffmpeg 的 segment 模块进行自动化无损分段
    cmd_split = [
        ffmpeg_exe, "-i", input_file,
        "-c", "copy",
        "-f", "segment",
        "-segment_time", str(segment_duration),
        "-reset_timestamps", "1",
        output_pattern
    ]
    subprocess.run(cmd_split, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    emit("log", f"分段文件前缀: {file_name}_part...{file_ext}")
    emit("success", f"✅ 极速切割完成！成功分为 {part_count} 段", 100)

def run(args_list):
    parser = argparse.ArgumentParser(description='Fast lossless video splitter')
    parser.add_argument('video_path', type=str, help='Path to the input video file')
    args = parser.parse_args(args_list)
    
    try:
        # 清除 Electron 传递路径时可能附带的双引号/单引号
        clean_path = args.video_path.strip('"').strip("'")
        fast_lossless_split(clean_path)
    except Exception as e:
        emit("error", f"执行出错: {str(e)}")


if __name__ == "__main__":
    run(sys.argv[1:])
