import cv2
import os
import sys
import json
import argparse
import multiprocessing as mp
import imagehash
from pathlib import Path
from PIL import Image
from send2trash import send2trash
import torch
import torch.nn.functional as F

def init_worker():
    if sys.platform.startswith('win'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
            sys.stderr.reconfigure(encoding='utf-8')
        except Exception:
            pass

# --- Electron 通信辅助函数 ---

def emit(event_type, message, data=None, progress=None):
    """
    发送 JSON 格式的消息给 Electron 主进程。
    """
    payload = {
        "type": event_type,
        "message": message
    }
    if data is not None:
        payload["data"] = data
    if progress is not None:
        payload["progress"] = progress
    
    # flush=True 确保前端立即收到
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def log_info(msg): emit('log', msg)
def log_success(msg): emit('success', msg)
def log_error(msg): emit('error', msg)
def log_progress(msg, percent): emit('progress', msg, progress=percent)

# --- 核心工具函数 ---

def sanitize_filename(filename):
    # 替换 Windows 非法字符为下划线
    invalid_chars = r'\/:*?"<>|'
    for char in invalid_chars:
        filename = filename.replace(char, '_')
    
    # 移除不可见的控制字符 (ASCII 0-31)
    filename = "".join(ch for ch in filename if ord(ch) >= 32)
    
    return filename.strip()

def check_cuda_support():
    if torch.cuda.is_available():
        count = torch.cuda.device_count()
        # 获取第一个 GPU 的名称
        gpu_name = torch.cuda.get_device_name(0)
        log_info(f"CUDA 就绪: {count} 个设备 ({gpu_name})")
        return True
    else:
        log_error("未检测到 CUDA 设备，脚本需要 NVIDIA 显卡才能高效运行。")
        return False

# GPU 加速的 SSIM 计算
def ssim_gpu(img1, img2):
    C1 = (0.01 * 255) ** 2
    C2 = (0.03 * 255) ** 2
    
    # 维度调整
    if len(img1.shape) == 2: img1 = img1.unsqueeze(0).unsqueeze(0)
    if len(img2.shape) == 2: img2 = img2.unsqueeze(0).unsqueeze(0)
    
    mu1 = F.avg_pool2d(img1, 3, 1)
    mu2 = F.avg_pool2d(img2, 3, 1)
    
    mu1_sq = mu1.pow(2)
    mu2_sq = mu2.pow(2)
    mu1_mu2 = mu1 * mu2
    
    sigma1_sq = F.avg_pool2d(img1 * img1, 3, 1) - mu1_sq
    sigma2_sq = F.avg_pool2d(img2 * img2, 3, 1) - mu2_sq
    sigma12 = F.avg_pool2d(img1 * img2, 3, 1) - mu1_mu2
    
    ssim_map = ((2 * mu1_mu2 + C1) * (2 * sigma12 + C2)) / ((mu1_sq + mu2_sq + C1) * (sigma1_sq + sigma2_sq + C2))
    return ssim_map.mean().item()

def calculate_sharpness(image):
    if image is None: return 0
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var()

def extract_best_frames(video_path, segments, fps, original_name, video_dir):
    """
    在识别出的稳定片段中，提取清晰度最高的一帧保存。
    """
    if not segments: return
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened(): return

    safe_base_name = sanitize_filename(os.path.splitext(original_name)[0])
    segments.sort(key=lambda x: x[0])
    current_frame_pos = 0
    
    for i, (start, end) in enumerate(segments, 1):
        # 为了避免转场残留，只取片段中间 80% 的区域进行检测
        duration = end - start
        if duration > 10:
            search_start = start + int(duration * 0.1)
            search_end = end - int(duration * 0.1)
        else:
            search_start = start
            search_end = end
            
        # 快速跳过 (线性扫描)
        while current_frame_pos < search_start:
            if not cap.grab(): break
            current_frame_pos += 1
            
        best_frame = None
        max_sharpness = -1.0
        best_frame_idx = -1
        
        # 如果片段很长，跳帧检测以提升速度
        stride = 2 if (search_end - search_start + 1) > 60 else 1
        
        while current_frame_pos <= search_end:
            ret, frame = cap.read()
            if not ret: break
            
            if (current_frame_pos - search_start) % stride == 0:
                sharpness = calculate_sharpness(frame)
                if sharpness > max_sharpness:
                    max_sharpness = sharpness
                    best_frame = frame.copy()
                    best_frame_idx = current_frame_pos
            current_frame_pos += 1
        
        # 保存最佳帧
        if best_frame is not None:
            # 构造文件名
            filename = os.path.join(video_dir, f"{safe_base_name}_{i}_f{best_frame_idx}.jpg")
            try:
                # 使用 imencode + binary write 解决 Windows 中文路径问题
                ret, img_encoded = cv2.imencode('.jpg', best_frame)
                if ret:
                    with open(filename, 'wb') as f:
                        f.write(img_encoded)
            except Exception as e:
                # 子进程中不方便直接 emit 到主进程 stdout，跳过报错
                pass

    cap.release()

# --- 视频分析逻辑 ---

def analyze_video(video_path, original_name, threshold_low, min_duration):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    cap = cv2.VideoCapture(video_path)
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    if not cap.isOpened() or total_frames < 2:
        return
    
    ret, prev_frame = cap.read()
    if not ret: return

    # 转为灰度并上传到 GPU
    prev_gray = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
    prev_gray = torch.from_numpy(prev_gray).to(device).float()
    ssim_scores = []
    
    # 逐帧计算 SSIM
    # 注意：多进程模式下，这里不方便实时 emit 进度给前端
    for i in range(total_frames - 1):
        ret, curr_frame = cap.read()
        if not ret: break
        
        curr_gray = cv2.cvtColor(curr_frame, cv2.COLOR_BGR2GRAY)
        curr_gray = torch.from_numpy(curr_gray).to(device).float()
        
        score = ssim_gpu(prev_gray, curr_gray)
        ssim_scores.append(score)
        
        prev_gray = curr_gray

    cap.release()
    
    # 根据阈值和最小持续时间，筛选稳定片段
    low_segments = []
    start_idx = 0
    in_segment = False
    
    for i, score in enumerate(ssim_scores):
        if score > threshold_low:
            if not in_segment:
                in_segment = True
                start_idx = i
        elif in_segment:
            in_segment = False
            # 只有持续时间超过 min_duration 才算有效片段
            if (i - start_idx) / fps >= min_duration:
                low_segments.append((start_idx, i-1))
    
    # 处理结尾
    if in_segment and (len(ssim_scores) - start_idx) / fps >= min_duration:
        low_segments.append((start_idx, len(ssim_scores)-1))
        
    # 提取帧
    extract_best_frames(video_path, low_segments, fps, original_name, os.path.dirname(video_path))
    
    log_success(f"完成: {original_name}")

# --- 图片去重逻辑 ---

def calculate_image_hash(file_path):
    try:
        with Image.open(file_path) as img:
            return str(imagehash.phash(img))
    except:
        return None

def process_images_deduplication(directory):
    directory = Path(directory)
    image_extensions = ['.jpg', '.jpeg', '.png']
    image_files = [f for f in directory.iterdir() if f.suffix.lower() in image_extensions]
    
    if not image_files: return

    log_info(f"正在扫描 {len(image_files)} 张图片进行去重...")
    
    # 1. 计算 Hash
    hash_dict = {}
    total = len(image_files)
    
    for idx, file_path in enumerate(image_files):
        h = calculate_image_hash(file_path)
        if h:
            if h in hash_dict: hash_dict[h].append(file_path)
            else: hash_dict[h] = [file_path]
        
        if idx % 10 == 0:
            # 简单的进度反馈
            percent = 50 + (idx / total) * 40 # 假设视频处理占前50%，这里占40%
            log_progress(f"Hash计算: {idx}/{total}", percent)

    # 2. 标记删除
    files_to_delete = []
    for img_hash, paths in hash_dict.items():
        if len(paths) > 1:
            # 按文件大小降序排序 (保留最大的文件，通常质量最好)
            paths.sort(key=lambda p: p.stat().st_size, reverse=True)
            # 标记除了第一个之外的所有文件
            files_to_delete.extend(paths[1:])

    # 3. 执行删除
    if files_to_delete:
        log_info(f"发现 {len(files_to_delete)} 张重复图片，正在移入回收站...")
        count = 0
        for path in files_to_delete:
            try:
                send2trash(str(path))
                count += 1
            except Exception as e:
                pass
        log_success(f"成功清理 {count} 张重复图片。")
    else:
        log_success("未发现重复图片。")

# --- 主入口 ---
        
def run(args_list):
    # 强制设置 Windows 下 stdout 为 utf-8，防止 JSON 中文乱码
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')

    # 定义命令行参数
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", type=str, required=True, help="目标工作目录")
    parser.add_argument("--threshold", type=float, default=0.95, help="SSIM 相似度阈值")
    parser.add_argument("--min_duration", type=float, default=0.2, help="最小片段持续时间(秒)")
    args = parser.parse_args(args_list)

    target_dir = args.path
    threshold = args.threshold
    min_duration = args.min_duration
    
    log_info("加载CUDA设备，可能需要一些时间...几十秒都是可能的...")

    if not os.path.exists(target_dir):
        log_error(f"路径不存在: {target_dir}")
        return

    # 1. 环境检查
    if not check_cuda_support():
        return

    # 2. 视频扫描与处理
    log_progress("扫描视频文件...", 5)
    video_extensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv']
    video_files = [f for f in os.listdir(target_dir) if os.path.splitext(f)[1].lower() in video_extensions]
    
    if video_files:
        log_info(f"找到 {len(video_files)} 个视频，阈值={threshold}, 最小间隔={min_duration}s")
        video_paths = [os.path.join(target_dir, f) for f in video_files]
        
        # 准备任务参数
        tasks = [(p, n, threshold, min_duration) for p, n in zip(video_paths, video_files)]
        
        # 限制最大进程数
        num_processes = min(mp.cpu_count(), len(video_files))
        
        # 启动多进程
        with mp.Pool(processes=num_processes, initializer=init_worker) as pool:
            pool.starmap(analyze_video, tasks)
        
        log_success("所有视频处理完成。")
    else:
        log_info("目录中未找到视频文件，跳过提取步骤。")

    # 3. 图片去重
    process_images_deduplication(target_dir)

    # 4. 结束
    log_progress("任务全部完成", 100)
    emit('success', "所有任务处理完毕。")

if __name__ == "__main__":
    mp.freeze_support()
    try:
        run(sys.argv[1:])
    except Exception as e:
        import traceback
        log_error(f"脚本发生严重错误: {str(e)}")
        sys.stderr.write(traceback.format_exc())