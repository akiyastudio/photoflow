import os
import sys
import shutil
import time
import datetime
import json
import argparse
from pathlib import Path
import gc

# --- 1. Electron 通信辅助 ---
def emit(event_type, message, data=None, progress=None):
    payload = {"type": event_type, "message": message}
    if data is not None: payload["data"] = data
    if progress is not None: payload["progress"] = progress
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def log_info(msg): emit('log', msg)
def log_success(msg): emit('success', msg)
def log_error(msg): emit('error', msg)
def log_progress(msg, percent): emit('progress', msg, progress=percent)
def log_status(msg, data=None): emit('status', msg, data)
def ask_user(msg, data=None): emit('ask_user', msg, data)

# --- 2. 辅助工具函数 ---
def safe_chunk_copy(src, dst, chunk_size=4 * 1024 * 1024):
    try:
        with open(src, 'rb') as fsrc, open(dst, 'wb') as fdst:
            while True:
                buf = fsrc.read(chunk_size)
                if not buf:
                    break
                fdst.write(buf)
                # 防止读卡器性能太差崩盘
                time.sleep(0.002) 
        
        shutil.copystat(src, dst)
    except Exception as e:
        # 如果中途出错（比如读卡器突然拔出），with open 会确保文件句柄被立即强制关闭
        # 避免 Windows 内核锁死
        raise e

def get_file_time(file_path):
    try: return os.path.getmtime(file_path)
    except: return 0

def classify_files_by_type(folder_path):
    """整理子文件夹"""
    ext_map = {
        'jpg': ('.jpg', '.jpeg', '.hif', '.heic'),
        'raw': ('.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.rwl', '.raf', '.3fr', '.fff'),
        'mov': ('.mp4', '.mov', '.avi', '.crm')
    }
    for f in os.listdir(folder_path):
        src_path = os.path.join(folder_path, f)
        if not os.path.isfile(src_path) or f.startswith('.'): continue
        f_lower = f.lower()
        for sub, exts in ext_map.items():
            if f_lower.endswith(exts):
                sub_dir = os.path.join(folder_path, sub)
                os.makedirs(sub_dir, exist_ok=True)
                # 如果子目录已有同名文件，加时间戳
                dst_path = os.path.join(sub_dir, f)
                if os.path.exists(dst_path):
                    name, ext = os.path.splitext(f)
                    dst_path = os.path.join(sub_dir, f"{name}_{int(time.time())}{ext}")
                shutil.move(src_path, dst_path)
                break

# --- 3. 核心导入流程 ---
def stage_import_and_organize(sd_path, dest_path, backup_path=None, split_threshold_hours=2.0, should_split=None):
    # 临时存放区（即使出错也保留，直到确认安全）
    temp_dir = os.path.join(dest_path, "_PhotoFlow_Safety_Temp")
    
    # 记录原始文件列表，用于最后的清理
    original_sd_files = []
    success_imported_count = 0

    try:
        time.sleep(2.5)
        # Step 1: 扫描 SD 卡 (仅扫描 DCIM 和 PRIVATE 目录)
        valid_exts = ('.jpg', '.jpeg', '.png', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.heic', '.mp4', '.mov', '.avi', '.rwl', '.raf', '.3fr', '.fff')
        
        # 兼容老配置，如果传过来的是 H:/DCIM，自动退回到根目录 H:/
        normalized_sd = os.path.normpath(sd_path)
        if normalized_sd.upper().endswith('DCIM'):
            base_sd = os.path.dirname(normalized_sd) # 完美安全地退回到上一级，如 G:\
        else:
            base_sd = normalized_sd
        
        # 定义需要扫描的目标子目录 (DCIM放大部分文件，PRIVATE放索尼高清视频)
        target_dirs = [os.path.join(base_sd, "DCIM"), os.path.join(base_sd, "PRIVATE")]
        
        for t_dir in target_dirs:
            if not os.path.exists(t_dir):
                continue
            for root, dirs, files in os.walk(t_dir):
                # 排除隐藏目录
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                for f in files:
                    # 排除隐藏文件并校验后缀
                    if not f.startswith('.') and f.lower().endswith(valid_exts):
                        original_sd_files.append(os.path.join(root, f))

                        if len(original_sd_files) % 10 == 0:
                            time.sleep(0.01)
        
        if not original_sd_files:
            log_info(f"在 {base_sd} 的 DCIM/PRIVATE 目录下没有找到媒体文件")
            return


# Step 2: 复制到临时区 (仅复制不存在或不完整的文件)
        os.makedirs(temp_dir, exist_ok=True)
        log_info(f"正在处理 {len(original_sd_files)} 个文件...")
        
        temp_files_list = []
        for idx, src in enumerate(original_sd_files):
            filename = os.path.basename(src)
            dst = os.path.join(temp_dir, filename)
            time.sleep(0.005)
            
            # 如果临时目录已存在该文件，且大小与原文件一致，则跳过复制
            if os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(src):
                temp_files_list.append(dst)
                log_progress(f"已就绪: {filename}", int(((idx+1)/len(original_sd_files))*100))
                continue
            
            # 如果文件名冲突（即临时文件夹有同名文件但大小不同，通常是不同目录下的同名文件）
            if os.path.exists(dst):
                name, ext = os.path.splitext(filename)
                dst = os.path.join(temp_dir, f"{name}_{int(time.time()*1000)}{ext}")
            
            # 执行复制
            try:
                safe_chunk_copy(src, dst)
            except Exception as e:
                log_error(f"复制文件 {filename} 时读卡器断开或报错: {e}")
                # 如果复制单个文件就报错了，极大概率是读卡器已经掉线，抛出异常让外层统一处理
                raise e 
            
            temp_files_list.append(dst)
            log_progress(f"导入中: {filename}", int(((idx+1)/len(original_sd_files))*100))

        # Step 3: 分组逻辑处理
        files_with_time = [(f, get_file_time(f)) for f in temp_files_list]
        files_with_time.sort(key=lambda x: x[1])

        # 检查是否需要分组提示
        need_split_check = False
        if len(files_with_time) > 1:
            for i in range(1, len(files_with_time)):
                if (files_with_time[i][1] - files_with_time[i-1][1]) / 3600.0 > split_threshold_hours:
                    need_split_check = True
                    break
        
        if need_split_check and should_split is None:
            ask_user("检测到长时间拍摄间隔，是否分文件夹整理？", {"need_split": True, "files_count": len(temp_files_list)})
            return

        # Step 4: 移动到最终目的地并分类
        groups = []
        if should_split and need_split_check:
            current_group = [files_with_time[0]]
            for i in range(1, len(files_with_time)):
                if (files_with_time[i][1] - files_with_time[i-1][1]) / 3600.0 > split_threshold_hours:
                    groups.append(current_group)
                    current_group = [files_with_time[i]]
                else:
                    current_group.append(files_with_time[i])
            groups.append(current_group)
        else:
            groups = [files_with_time]

        log_info(f"正在整理到目标文件夹...")
        for idx, group in enumerate(groups):
            # 命名文件夹
            first_time = group[0][1]
            date_str = datetime.datetime.fromtimestamp(first_time).strftime('%m-%d').lstrip('0').replace('-0', '-')
            if len(groups) > 1:
                date_str = f"{date_str}-{idx+1}"
            
            target_folder = os.path.join(dest_path, date_str)
            os.makedirs(target_folder, exist_ok=True)
            
            for f_path, _ in group:
                shutil.move(f_path, os.path.join(target_folder, os.path.basename(f_path)))
                success_imported_count += 1
            
            classify_files_by_type(target_folder)
            
            # 备份
            if backup_path and os.path.exists(backup_path):
                backup_dst = os.path.join(backup_path, date_str)
                if os.path.exists(backup_dst): shutil.rmtree(backup_dst)
                shutil.copytree(target_folder, backup_dst)

        # Step 5: 最终校验与清理 SD 卡
        if success_imported_count == len(original_sd_files):
            log_success(f"整理完成，共处理 {success_imported_count} 个文件")
            
            # 只有在此刻，才开始清理 SD 卡
            log_info("正在安全清理 SD 卡原始文件...")
            for f in original_sd_files:
                try:
                    os.remove(f)
                except:
                    pass
            log_success("SD 卡清理完成")
            
            # 只有全部成功，才清理临时目录
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)
        else:
            log_error(f"警告：导入数量不匹配（应有{len(original_sd_files)}，实际{success_imported_count}）。SD 卡未清理，请检查桌面临时文件夹。")

    except Exception as e:
        log_error(f"流程异常: {str(e)}")
        # 异常情况下保留临时文件夹和 SD 卡文件，确保数据不丢
        gc.collect()

def run(args_list):
    if sys.platform.startswith('win'):
        if sys.stdout: sys.stdout.reconfigure(encoding='utf-8')
        if sys.stderr: sys.stderr.reconfigure(encoding='utf-8')
        
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True)
    parser.add_argument("--sd_path", default="")
    parser.add_argument("--dest_path", default="")
    parser.add_argument("--backup_path", default="")
    parser.add_argument("--time_gap", type=float, default=2.0)
    parser.add_argument("--should_split", type=str, default="")

    args, _ = parser.parse_known_args(args_list)
    
    split_val = None
    if args.should_split.lower() == 'true': split_val = True
    elif args.should_split.lower() == 'false': split_val = False

    if args.stage == 'check':
        log_status("SD Card Detected" if os.path.exists(args.sd_path) else "No Device", {"connected": os.path.exists(args.sd_path)})
    elif args.stage == 'import':
        stage_import_and_organize(args.sd_path, args.dest_path, args.backup_path, args.time_gap, split_val)

if __name__ == "__main__":
    run(sys.argv[1:])