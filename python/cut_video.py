import os
import re
import sys
import json
import argparse
import subprocess
import imageio_ffmpeg

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
    
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    
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
    midpoint = total_seconds / 2.0
    
    emit("log", f"视频总时长: {total_seconds:.2f} 秒，切割中点: {midpoint:.2f} 秒")
    
    file_name, file_ext = os.path.splitext(input_file)
    output1 = f"{file_name}_上集{file_ext}"
    output2 = f"{file_name}_下集{file_ext}"
    
    # 2. 切割第一部分
    emit("progress", "⚡ 正在极速无损切割【上集】...", 40)
    cmd_part1 = [ffmpeg_exe, "-i", input_file, "-t", str(midpoint), "-c", "copy", "-y", output1]
    subprocess.run(cmd_part1, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    # 3. 切割第二部分
    emit("progress", "⚡ 正在极速无损切割【下集】...", 70)
    cmd_part2 = [ffmpeg_exe, "-i", input_file, "-ss", str(midpoint), "-c", "copy", "-y", output2]
    subprocess.run(cmd_part2, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    emit("log", f"上集路径: {output1}")
    emit("log", f"下集路径: {output2}")
    emit("success", "✅ 极速切割完成！(画质和 HDR 均已保留)", 100)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Fast lossless video splitter')
    parser.add_argument('video_path', type=str, help='Path to the input video file')
    args = parser.parse_args()
    
    try:
        fast_lossless_split(args.video_path)
    except Exception as e:
        emit("error", f"执行出错: {str(e)}")