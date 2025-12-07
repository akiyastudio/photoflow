import os
import sys
import shutil
import time
import datetime
import json
import argparse
from pathlib import Path

# --- 1. Electron 通信辅助函数 ---

def emit(event_type, message, data=None, progress=None):
    payload = {
        "type": event_type,
        "message": message
    }
    if data is not None:
        payload["data"] = data
    if progress is not None:
        payload["progress"] = progress
    
    # flush=True 确保 Electron 能立即收到消息
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def log_info(msg): emit('log', msg)
def log_success(msg): emit('success', msg)
def log_error(msg): emit('error', msg)
def log_progress(msg, percent): emit('progress', msg, progress=percent)
def log_status(msg, data=None): emit('status', msg, data)
def ask_user(msg, data=None): emit('ask_user', msg, data)

# --- 2. 核心逻辑函数 ---

def get_file_time(file_path):
    """获取文件修改时间作为拍摄时间"""
    try:
        return os.path.getmtime(file_path)
    except:
        return 0

def has_split_needed(files_with_time, split_threshold_hours=2.0):
    """检查是否需要按时间断层分组"""
    if len(files_with_time) < 2:
        return False, []
    
    for i in range(1, len(files_with_time)):
        _, t = files_with_time[i]
        _, prev_t = files_with_time[i-1]
        diff_hours = (t - prev_t) / 3600.0
        
        if diff_hours > split_threshold_hours:
            return True, None
    return False, None

def group_files_by_time(files_with_time, split_threshold_hours=2.0):
    """按时间阈值分组"""
    groups = []
    if not files_with_time:
        return groups
    
    current_group = [files_with_time[0]]
    groups.append(current_group)
    
    for i in range(1, len(files_with_time)):
        path, t = files_with_time[i]
        prev_path, prev_t = files_with_time[i-1]
        
        diff_hours = (t - prev_t) / 3600.0
        
        if diff_hours > split_threshold_hours:
            current_group = [(path, t)]
            groups.append(current_group)
        else:
            current_group.append((path, t))
    
    return groups

def get_group_date_name(file_path_time_list, group_idx=None):
    """生成日期文件夹名 (MM-DD)"""
    if not file_path_time_list:
        return "unknown"
    
    first_file_path, first_time = file_path_time_list[0]
    date_obj = datetime.datetime.fromtimestamp(first_time)
    date_str = date_obj.strftime('%m-%d').lstrip('0').replace('-0', '-')
    
    if group_idx is not None:
        date_str = f"{date_str}-{group_idx + 1}"
    
    return date_str

def move_existing_images_to_plan(target_dir):
    """如果目标文件夹已有图片，移入'策划'子文件夹"""
    if not os.path.exists(target_dir):
        return
    
    img_exts = ('.jpg', '.jpeg', '.png', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.heic', '.mov', '.mp4', '.avi', '.rwl', '.raf', '.3fr', '.fff')
    
    # 忽略以 . 开头的文件
    existing_files = [
        f for f in os.listdir(target_dir)
        if os.path.isfile(os.path.join(target_dir, f)) 
        and f.lower().endswith(img_exts)
        and not f.startswith('.')
    ]

    if existing_files:
        plan_dir = os.path.join(target_dir, "策划")
        try:
            os.makedirs(plan_dir, exist_ok=True)
            log_info(f"检测到 {target_dir} 中已有 {len(existing_files)} 张图片，移到 '策划' 文件夹")
            
            for f in existing_files:
                src = os.path.join(target_dir, f)
                dst = os.path.join(plan_dir, f)
                
                if os.path.exists(dst):
                    name, ext = os.path.splitext(f)
                    timestamp = int(time.time())
                    dst = os.path.join(plan_dir, f"{name}_{timestamp}{ext}")
                
                shutil.move(src, dst)
        except Exception as e:
            log_error(f"移动既有图片到策划文件夹失败: {e}")

def classify_files_by_type(folder_path):
    """将文件夹内的文件归类到 jpg/raw/mov"""
    jpg_dir = os.path.join(folder_path, "jpg")
    raw_dir = os.path.join(folder_path, "raw")
    mov_dir = os.path.join(folder_path, "mov")
    
    jpg_exts = ('.jpg', '.jpeg')
    raw_exts = ('.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.rwl', '.raf', '.3fr', '.fff')
    mov_exts = ('.mp4', '.mov', '.avi')
    
    try:
        for f in os.listdir(folder_path):
            file_path = os.path.join(folder_path, f)
            
            if os.path.isdir(file_path) or f.startswith('.'):
                continue
            
            dst_dir = None
            if f.lower().endswith(jpg_exts):
                dst_dir = jpg_dir
            elif f.lower().endswith(raw_exts):
                dst_dir = raw_dir
            elif f.lower().endswith(mov_exts):
                dst_dir = mov_dir
            
            if dst_dir:
                os.makedirs(dst_dir, exist_ok=True)
                dst = os.path.join(dst_dir, f)
                if os.path.exists(dst):
                    name, ext = os.path.splitext(f)
                    dst = os.path.join(dst_dir, f"{name}_{int(time.time())}{ext}")
                shutil.move(file_path, dst)
    
    except Exception as e:
        log_error(f"文件分类失败: {e}")

def copy_sd_to_temp(sd_path, temp_dir):
    """
    带进度条的复制函数：
    1. 预扫描计算总数
    2. 逐个复制并实时回报进度和文件名
    3. 尽量保持原文件名
    """
    if not os.path.exists(sd_path):
        log_error(f"SD 路径不存在: {sd_path}")
        return []
    
    if not os.path.exists(temp_dir):
        os.makedirs(temp_dir)
    
    valid_exts = ('.jpg', '.jpeg', '.png', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', 
                  '.heic', '.mp4', '.mov', '.avi', '.rwl', '.raf', '.3fr', '.fff')
    
    # --- 第一步：预扫描 ---
    log_status("正在扫描文件总数...", {"connected": True})
    files_to_copy = []
    
    try:
        for root, dirs, files in os.walk(sd_path):
            dirs[:] = [d for d in dirs if not d.startswith('.')] # 排除隐藏文件夹
            
            for f in files:
                if f.startswith('.'): continue
                
                if f.lower().endswith(valid_exts):
                    src_path = os.path.join(root, f)
                    
                    # 过滤过小的 JPG (缩略图)
                    if f.lower().endswith(('.jpg', '.jpeg')):
                        try:
                            if os.path.getsize(src_path) < 50 * 1024: # < 50KB
                                continue
                        except:
                            pass
                    
                    files_to_copy.append(src_path)
    except Exception as e:
        log_error(f"扫描 SD 卡失败: {e}")
        return []

    total_files = len(files_to_copy)
    if total_files == 0:
        log_info("未找到可导入的媒体文件")
        return []

    # --- 第二步：开始复制 ---
    copied_files = []
    
    for idx, src in enumerate(files_to_copy):
        filename = os.path.basename(src)
        percent = int(((idx + 1) / total_files) * 100)
        
        # 发送文件名给前端显示
        log_progress(f"正在导入: {filename}", percent)
        
        dst = os.path.join(temp_dir, filename)
        
        try:
            # 仅当重名时才改名
            if os.path.exists(dst):
                base, ext = os.path.splitext(filename)
                timestamp = int(time.time())
                dst = os.path.join(temp_dir, f"{base}_{timestamp}{ext}")
            
            shutil.copy2(src, dst)
            copied_files.append(dst)
            
        except Exception as e:
            # 打印警告但不中断
            print(json.dumps({"type": "warning", "message": f"复制失败 {filename}: {str(e)}"}, ensure_ascii=False), flush=True)

    log_success(f"导入完成，共处理 {len(copied_files)} 个文件")
    return copied_files

def cleanup_sd_card(sd_path):
    """在确认文件安全后清理 SD 卡"""
    valid_exts = ('.jpg', '.jpeg', '.png', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', 
                  '.heic', '.mp4', '.mov', '.avi', '.rwl', '.raf', '.3fr', '.fff')
    try:
        log_info("正在清理 SD 卡原始文件...")
        for root, dirs, files in os.walk(sd_path):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for f in files:
                if f.startswith('.'): continue
                if f.lower().endswith(valid_exts):
                    try:
                        os.remove(os.path.join(root, f))
                    except:
                        pass
        log_success("SD 卡清理完成")
    except Exception as e:
        log_error(f"清理 SD 卡失败: {e}")

def organize_photos_new(dest_path, temp_files, split_threshold_hours=2.0, should_split=None, backup_path=None):
    """
    整理逻辑：从 Temp 移动到目标日期文件夹
    """
    if not temp_files:
        return
    
    dest_path = os.path.abspath(dest_path)
    
    # 获取时间并排序
    files_with_time = [(f, get_file_time(f)) for f in temp_files]
    files_with_time.sort(key=lambda x: x[1])
    
    # 检查是否需要分组
    need_split, _ = has_split_needed(files_with_time, split_threshold_hours)
    
    if need_split and should_split is None:
        ask_user("检测到照片存在2小时以上的拍摄间隔，是否要分开文件夹？", {
            "files_count": len(temp_files),
            "need_split": True
        })
        return
    
    do_split = need_split and should_split is True
    processed_folders = []

    try:
        if do_split:
            groups = group_files_by_time(files_with_time, split_threshold_hours)
            log_info(f"将文件分为 {len(groups)} 组处理")
            
            for idx, group in enumerate(groups):
                date_name = get_group_date_name(group, idx)
                group_folder = os.path.join(dest_path, date_name)
                
                os.makedirs(group_folder, exist_ok=True)
                move_existing_images_to_plan(group_folder)
                
                for file_path, _ in group:
                    filename = os.path.basename(file_path)
                    dst = os.path.join(group_folder, filename)
                    if os.path.exists(dst):
                        base, ext = os.path.splitext(filename)
                        dst = os.path.join(group_folder, f"{base}_{int(time.time())}{ext}")
                    shutil.move(file_path, dst)
                
                classify_files_by_type(group_folder)
                processed_folders.append(group_folder)
                log_progress(f"处理: {date_name}", int((idx + 1) / len(groups) * 100))
        else:
            date_name = get_group_date_name(files_with_time)
            group_folder = os.path.join(dest_path, date_name)
            
            os.makedirs(group_folder, exist_ok=True)
            move_existing_images_to_plan(group_folder)
            
            for file_path, _ in files_with_time:
                filename = os.path.basename(file_path)
                dst = os.path.join(group_folder, filename)
                if os.path.exists(dst):
                    base, ext = os.path.splitext(filename)
                    dst = os.path.join(group_folder, f"{base}_{int(time.time())}{ext}")
                shutil.move(file_path, dst)
            
            classify_files_by_type(group_folder)
            processed_folders.append(group_folder)

        # 备份逻辑
        if backup_path and os.path.exists(backup_path):
            log_info("正在进行备份...")
            for folder in processed_folders:
                folder_name = os.path.basename(folder)
                backup_dst = os.path.join(backup_path, folder_name)
                if not os.path.exists(backup_dst):
                    shutil.copytree(folder, backup_dst)
                else:
                    log_info(f"备份目标已存在，跳过: {backup_dst}")
            log_success("整理与备份全部完成")
        else:
            log_success("整理完成")

    except Exception as e:
        log_error(f"整理过程出错: {e}")

# --- 3. 阶段入口函数 ---

def stage_check(sd_path):
    """检测 SD 卡是否存在"""
    if os.path.exists(sd_path):
        log_status("SD Card Detected", {"connected": True, "path": sd_path})
    else:
        log_status("No Device", {"connected": False})

def stage_import_and_organize(sd_path, dest_path, backup_path=None, split_threshold_hours=2.0, should_split=None):
    """
    完整的导入流程：
    1. 强制清理旧的固定临时目录
    2. 创建新的临时目录
    3. 扫描并复制文件 (带进度)
    4. 整理分类
    5. 删除临时目录
    """
    if not os.path.exists(sd_path):
        log_error(f"源路径不存在: {sd_path}")
        return

    if not os.path.exists(dest_path):
        try:
            os.makedirs(dest_path)
        except Exception as e:
            log_error(f"无法创建目标路径: {e}")
            return
    
    # 使用固定名称，防止生成一堆临时文件夹
    temp_folder_name = "_PhotoFlow_Processing_Zone"
    temp_dir = os.path.join(dest_path, temp_folder_name)
    
    # 步骤 1: 强制清理残留
    if os.path.exists(temp_dir):
        try:
            log_info("清理旧的缓存区域...")
            shutil.rmtree(temp_dir)
            time.sleep(0.5) 
        except Exception as e:
            log_error(f"无法清理临时文件夹，请手动删除桌面的 {temp_folder_name}")
            return

    try:
        os.makedirs(temp_dir, exist_ok=True)

        # 步骤 2 & 3: 复制到临时目录
        copied_files = copy_sd_to_temp(sd_path, temp_dir)
        
        if not copied_files:
            try:
                os.rmdir(temp_dir)
            except:
                pass
            return
        
        # 步骤 4: 整理
        organize_photos_new(dest_path, copied_files, split_threshold_hours, should_split, backup_path)

        cleanup_sd_card(sd_path)
        
    except Exception as e:
        log_error(f"导入流程异常: {e}")
        import traceback
        traceback.print_exc()
        
    finally:
        # 步骤 5: 最终清理
        if os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
            except Exception as e:
                pass

# --- 4. 程序主入口 ---

def run(args_list):
    if sys.platform.startswith('win'):
        if sys.stdout: sys.stdout.reconfigure(encoding='utf-8')
        if sys.stderr: sys.stderr.reconfigure(encoding='utf-8')

    username = os.getenv('USERNAME') or 'user'
    
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True, choices=['check', 'import', 'process'], help="Run stage")
    parser.add_argument("--sd_path", default="H:/DCIM")
    parser.add_argument("--dest_path", default=f"C:/Users/{username}/Desktop")
    parser.add_argument("--backup_path", default="")
    parser.add_argument("--time_gap", type=float, default=2.0)
    parser.add_argument("--should_split", type=str, default="")

    args, _ = parser.parse_known_args(args_list)

    sd_path = args.sd_path.strip('"').strip("'")
    dest_path = args.dest_path.strip('"').strip("'")
    backup_path = args.backup_path.strip('"').strip("'") if args.backup_path else None
    
    should_split = None
    if args.should_split:
        if args.should_split.lower() == 'true': should_split = True
        elif args.should_split.lower() == 'false': should_split = False

    try:
        if args.stage == 'check':
            stage_check(sd_path)
        elif args.stage == 'import':
            stage_import_and_organize(sd_path, dest_path, backup_path, args.time_gap, should_split)
            
    except Exception as e:
        log_error(f"Run Error: {str(e)}")

if __name__ == "__main__":
    run(sys.argv[1:])