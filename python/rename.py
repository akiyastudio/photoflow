import os
import shutil
import sys
import argparse
import io
import subprocess
from event_protocol import emit, log_error, log_info, log_progress, log_success
from PIL import Image
from ffmpeg_utils import get_ffmpeg_exe

IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff')
VIDEO_EXTENSIONS = ('.mp4', '.mov', '.avi', '.m4v', '.mkv', '.webm', '.crm')
RAW_EXTENSIONS = ('.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw')
FFMPEG_IMAGE_EXTENSIONS = ('.heic', '.avif') + RAW_EXTENSIONS

def load_visual_frame(media_path):
    extension = os.path.splitext(media_path)[1].lower()
    if extension in VIDEO_EXTENSIONS or extension in FFMPEG_IMAGE_EXTENSIONS:
        ffmpeg_exe = get_ffmpeg_exe()
        if not ffmpeg_exe:
            raise RuntimeError('FFmpeg 未安装，无法分析此媒体版本')
        command = [ffmpeg_exe, '-hide_banner', '-loglevel', 'error']
        if extension in VIDEO_EXTENSIONS:
            command.extend(['-ss', '0.2'])
        command.extend(['-i', media_path, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'])
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if result.returncode != 0 or not result.stdout:
            raise RuntimeError(result.stderr.decode('utf-8', errors='replace').strip() or '无法提取视频画面')
        return Image.open(io.BytesIO(result.stdout))
    return Image.open(media_path)

def calculate_hashes(media_path):
    try:
        with load_visual_frame(media_path) as img:
            img_gray = img.convert('L')
            
            # 1. 粗略哈希 (aHash 8x8 -> 64 bits) - 用于快速筛选
            img_coarse = img_gray.resize((8, 8), Image.LANCZOS)
            pixels_coarse = list(img_coarse.getdata())
            avg = sum(pixels_coarse) / len(pixels_coarse)
            coarse_hash = 0
            for i, p in enumerate(pixels_coarse):
                if p > avg: coarse_hash |= 1 << i

            # 2. 精细哈希 (dHash 16x16 -> 256 bits) - 用于精准区分细节
            # dHash 原理：对比相邻像素的明暗，能极其敏锐地捕捉画面结构的微小变化
            img_fine = img_gray.resize((17, 16), Image.LANCZOS)
            pixels_fine = list(img_fine.getdata())
            fine_hash = 0
            for row in range(16):
                for col in range(16):
                    # 对比当前像素和右边相邻像素
                    if pixels_fine[row * 17 + col] > pixels_fine[row * 17 + col + 1]:
                        fine_hash |= 1 << (row * 16 + col)

            return coarse_hash, fine_hash
    except Exception:
        return None, None

def hamming_distance(hash1, hash2):
    if hash1 is None or hash2 is None: return float('inf')
    return bin(hash1 ^ hash2).count('1')

def copy_unmatched_a_files(unmatched_files_a, folder_a):
    if not unmatched_files_a: return
    unmatched_a_folder = os.path.join(folder_a, "未匹配的图片_A")
    os.makedirs(unmatched_a_folder, exist_ok=True)
    
    log_info(f"正在复制 文件夹A 中未匹配的 {len(unmatched_files_a)} 个文件...")
    for filename in unmatched_files_a:
        src = os.path.join(folder_a, filename)
        dst = os.path.join(unmatched_a_folder, filename)
        counter = 1
        while os.path.exists(dst):
            name, ext = os.path.splitext(filename)
            dst = os.path.join(unmatched_a_folder, f"{name}_{counter}{ext}")
            counter += 1
        try:
            shutil.copy2(src, dst)
        except Exception:
            pass

def process_folders(folder_a, folder_b, threshold, auto_copy_unmatched, preview_only=False, move_unmatched=False):
    media_extensions = IMAGE_EXTENSIONS + FFMPEG_IMAGE_EXTENSIONS + VIDEO_EXTENSIONS
    
    # 1. 分析 文件夹A
    log_info("正在分析 文件夹A (参照组)...")
    files_a = {}
    list_a = [f for f in os.listdir(folder_a) if f.lower().endswith(media_extensions)]
    for i, f in enumerate(list_a):
        path = os.path.join(folder_a, f)
        h_coarse, h_fine = calculate_hashes(path)
        if h_coarse is not None: files_a[f] = (path, h_coarse, h_fine, 'video' if f.lower().endswith(VIDEO_EXTENSIONS) else 'image')
        if i % 10 == 0: log_progress(f"分析 A: {i}/{len(list_a)}", int(i/len(list_a)*20))

    # 2. 分析 文件夹B
    log_info("正在分析 文件夹B (待处理组)...")
    files_b = {}
    list_b = [f for f in os.listdir(folder_b) if f.lower().endswith(media_extensions)]
    for i, f in enumerate(list_b):
        path = os.path.join(folder_b, f)
        h_coarse, h_fine = calculate_hashes(path)
        if h_coarse is not None: files_b[f] = (path, h_coarse, h_fine, 'video' if f.lower().endswith(VIDEO_EXTENSIONS) else 'image')
        if i % 10 == 0: log_progress(f"分析 B: {i}/{len(list_b)}", 20 + int(i/len(list_b)*20))

    if not files_a:
        log_error("文件夹A 中没有可用于对照的图片或视频")
        return False
    if not files_b:
        log_error("文件夹B 中没有图片或视频")
        return False

    # 3. 收集并计算所有候选匹配对 (粗筛)
    log_info("正在进行深度交叉比对...")
    potential_matches = []
    
    total_a = len(files_a)
    for idx, (file_a, (path_a, coarse_a, fine_a, kind_a)) in enumerate(files_a.items()):
        for file_b, (path_b, coarse_b, fine_b, kind_b) in files_b.items():
            if kind_a != kind_b:
                continue
            rough_dist = hamming_distance(coarse_a, coarse_b)
            # 如果粗略差距在阈值内，视为候选对象
            if rough_dist <= threshold:
                fine_dist = hamming_distance(fine_a, fine_b)
                # Very different fine hashes are more likely a false match than
                # an edited version of the same frame.
                if fine_dist <= 96:
                    potential_matches.append((fine_dist, rough_dist, file_a, file_b))
        
        if idx % 5 == 0:
            log_progress(f"交叉比对: {idx}/{total_a}", 40 + int(idx/total_a*10))

    # 核心改动：全局排序 (精筛)
    # 按 精细差距(第一优先) 和 粗略差距(第二优先) 从小到大排序
    potential_matches.sort(key=lambda x: (x[0], x[1]))

    # 4. 执行重命名 (最优分配)
    log_info("开始执行精准重命名...")
    processed_b = set()
    matched_a = {f: 0 for f in files_a}
    preview_matches = []
    reserved_targets = set()
    
    total_matches = len(potential_matches)
    for idx, (fine_dist, rough_dist, file_a, file_b) in enumerate(potential_matches):
        # 如果这个待处理文件已经被最适合它的参照文件领走了，跳过
        if file_b in processed_b:
            continue
            
        path_b = files_b[file_b][0]
        name, _reference_ext = os.path.splitext(file_a)
        _current_name, ext = os.path.splitext(file_b)
        
        m_idx = matched_a[file_a] + 1
        
        # 命名逻辑
        if m_idx == 1: new_name = f"{name}{ext}"
        else: new_name = f"{name}_{m_idx}{ext}"
        
        new_path_b = os.path.join(folder_b, new_name)

        # 防止同名覆盖，也在预览阶段预留已经分配的目标文件名。
        c = 1
        while (new_name.casefold() in reserved_targets
               or (os.path.exists(new_path_b) and os.path.normcase(os.path.abspath(new_path_b)) != os.path.normcase(os.path.abspath(path_b)))):
            if m_idx == 1: new_name = f"{name}_{c}{ext}"
            else: new_name = f"{name}_{m_idx+c-1}{ext}"
            new_path_b = os.path.join(folder_b, new_name)
            c += 1
        
        confidence = "高" if fine_dist <= 40 else "中" if fine_dist <= 72 else "低"
        preview_matches.append({"source": file_b, "reference": file_a, "target": new_name, "confidence": confidence, "distance": fine_dist})
        reserved_targets.add(new_name.casefold())
        if preview_only or os.path.normcase(os.path.abspath(path_b)) == os.path.normcase(os.path.abspath(new_path_b)):
            processed_b.add(file_b)
            matched_a[file_a] += 1
        else:
            try:
                os.rename(path_b, new_path_b)
                processed_b.add(file_b)
                matched_a[file_a] += 1
            except Exception as error:
                log_error(f"重命名失败：{file_b}（{error}）")
            
        if idx % 10 == 0:
            log_progress(f"重命名进度: {idx}/{total_matches}", 50 + int(idx/total_matches*40))

    # 5. 处理未匹配
    unmatched_b = [f for f in files_b if f not in processed_b]
    if unmatched_b and not preview_only and move_unmatched:
        sub_folder = os.path.join(folder_b, "未匹配的图片")
        os.makedirs(sub_folder, exist_ok=True)
        for f in unmatched_b:
            src = files_b[f][0]
            dst = os.path.join(sub_folder, f)
            c = 1
            while os.path.exists(dst):
                n, e = os.path.splitext(f)
                dst = os.path.join(sub_folder, f"{n}_{c}{e}")
                c += 1
            shutil.move(src, dst)

    unmatched_a = [f for f in files_a if matched_a[f] == 0]
    
    stats = (f"待处理组匹配成功:{len(processed_b)}/{len(files_b)}, 参照组已被匹配:{sum(1 for v in matched_a.values() if v>0)}/{len(files_a)}")
    if preview_only:
        emit('preview', f"预览完成：找到 {len(preview_matches)} 个匹配", {"matches": preview_matches, "unmatched": unmatched_b, "unmatchedReference": unmatched_a})
        log_success(f"预览完成，尚未修改文件。{stats}")
        return True
    log_success(f"完成! {stats}")

    if unmatched_a and auto_copy_unmatched:
        copy_unmatched_a_files(unmatched_a, folder_a)
        log_success("已复制参照组中未匹配的文件")
    return True

def run(args_list):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    
    parser = argparse.ArgumentParser()
    parser.add_argument("--folder_a", required=True)
    parser.add_argument("--folder_b", required=True)
    parser.add_argument("--copy_unmatched", action="store_true")
    parser.add_argument("--threshold", type=int, default=5)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--move_unmatched", action="store_true")
    args = parser.parse_args(args_list)

    # 清理路径
    fa = args.folder_a.strip('"').strip("'")
    fb = args.folder_b.strip('"').strip("'")
    
    if not os.path.exists(fa) or not os.path.exists(fb):
        log_error("文件夹不存在")
        return

    try:
        if process_folders(fa, fb, args.threshold, args.copy_unmatched, args.preview, args.move_unmatched):
            emit('success', "所有任务结束")
    except Exception as e:
        log_error(f"错误: {e}")

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")
