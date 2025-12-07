import os
import shutil
import sys
import json
import argparse
from PIL import Image

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

def calculate_hash(image_path, hash_size=8):
    try:
        with Image.open(image_path) as img:
            img = img.resize((hash_size + 1, hash_size), Image.LANCZOS).convert('L')
            pixels = list(img.getdata())
            avg = sum(pixels) / len(pixels)
            hash_value = 0
            for i in range(hash_size):
                for j in range(hash_size):
                    if pixels[i * hash_size + j] > avg:
                        hash_value |= 1 << (i * hash_size + j)
            return hash_value
    except Exception:
        return None

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

def process_folders(folder_a, folder_b, threshold, auto_copy_unmatched):
    image_extensions = ('.jpg', '.jpeg', '.png', '.bmp', '.gif')
    
    # 1. 分析 文件夹A
    log_info("正在分析 文件夹A (参照组)...")
    files_a = {}
    list_a = [f for f in os.listdir(folder_a) if f.lower().endswith(image_extensions)]
    for i, f in enumerate(list_a):
        path = os.path.join(folder_a, f)
        h = calculate_hash(path)
        if h is not None: files_a[f] = (path, h)
        if i % 10 == 0: log_progress(f"分析 A: {i}/{len(list_a)}", int(i/len(list_a)*20))

    # 2. 分析 文件夹A
    log_info("正在分析 文件夹A (待处理组)...")
    files_b = {}
    list_b = [f for f in os.listdir(folder_b) if f.lower().endswith(image_extensions)]
    for i, f in enumerate(list_b):
        path = os.path.join(folder_b, f)
        h = calculate_hash(path)
        if h is not None: files_b[f] = (path, h)
        if i % 10 == 0: log_progress(f"分析 B: {i}/{len(list_b)}", 20 + int(i/len(list_b)*20))

    if not files_b:
        log_error("文件夹A 中没有图片")
        return

    processed_b = set()
    matched_a = {f: 0 for f in files_a}
    
    # 3. 比对重命名
    log_info("开始比对并重命名...")
    total = len(files_a)
    
    for idx, (file_a, (path_a, hash_a)) in enumerate(files_a.items()):
        matches = []
        for file_b, (path_b, hash_b) in files_b.items():
            if file_b not in processed_b and hamming_distance(hash_a, hash_b) <= threshold:
                matches.append(file_b)
        
        for m_idx, file_b in enumerate(matches, 1):
            path_b, _ = files_b[file_b]
            name, ext = os.path.splitext(file_a)
            
            # 命名逻辑
            if m_idx == 1: new_name = f"{name}{ext}"
            else: new_name = f"{name}_{m_idx}{ext}"
            
            new_path_b = os.path.join(folder_b, new_name)
            
            # 防止同名覆盖
            c = 1
            while os.path.exists(new_path_b):
                if m_idx == 1: new_name = f"{name}_{c}{ext}"
                else: new_name = f"{name}_{m_idx+c-1}{ext}"
                new_path_b = os.path.join(folder_b, new_name)
                c += 1
            
            try:
                os.rename(path_b, new_path_b)
                processed_b.add(file_b)
                matched_a[file_a] += 1
            except Exception:
                pass
        
        if idx % 5 == 0:
            log_progress(f"比对进度: {idx}/{total}", 40 + int(idx/total*50))

    # 4. 处理未匹配
    unmatched_b = [f for f in files_b if f not in processed_b]
    if unmatched_b:
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
    
    stats = (f"B匹配:{len(processed_b)}/{len(files_b)}, A匹配:{sum(1 for v in matched_a.values() if v>0)}/{len(files_a)}")
    log_success(f"完成! {stats}")

    if unmatched_a and auto_copy_unmatched:
        copy_unmatched_a_files(unmatched_a, folder_a)
        log_success("已复制A中未匹配文件")

def run(args_list):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    
    parser = argparse.ArgumentParser()
    parser.add_argument("--folder_a", required=True)
    parser.add_argument("--folder_b", required=True)
    parser.add_argument("--copy_unmatched", action="store_true")
    parser.add_argument("--threshold", type=int, default=5)
    args = parser.parse_args(args_list)

    # 清理路径
    fa = args.folder_a.strip('"').strip("'")
    fb = args.folder_b.strip('"').strip("'")
    
    if not os.path.exists(fa) or not os.path.exists(fb):
        log_error("文件夹不存在")
        return

    try:
        process_folders(fa, fb, args.threshold, args.copy_unmatched)
        emit('success', "所有任务结束")
    except Exception as e:
        log_error(f"错误: {e}")

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")