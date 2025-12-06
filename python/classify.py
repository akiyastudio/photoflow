import os
import sys
import shutil
import time
import datetime
import json
import argparse
from pathlib import Path
import os

# --- Electron 通信辅助函数 ---

def emit(event_type, message, data=None, progress=None):
    payload = {
        "type": event_type,
        "message": message
    }
    if data is not None:
        payload["data"] = data
    if progress is not None:
        payload["progress"] = progress
    
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def log_info(msg): emit('log', msg)
def log_success(msg): emit('success', msg)
def log_error(msg): emit('error', msg)
def log_progress(msg, percent): emit('progress', msg, progress=percent)
def log_status(msg, data=None): emit('status', msg, data)
def ask_user(msg, data=None): emit('ask_user', msg, data)

# --- 核心逻辑函数 ---

def get_file_time(file_path):
    """获取文件修改时间作为拍摄时间"""
    try:
        return os.path.getmtime(file_path)
    except:
        return 0

def has_split_needed(files_with_time, split_threshold_hours=2.0):
    """
    检查文件列表中是否存在相隔指定小时数的拍摄
    返回: (是否需要分组, 分组信息)
    """
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
    """
    按时间阈值对文件进行分组
    返回: [(日期字符串, 分组索引, [文件列表])]
    """
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
    """
    获取分组的日期命名 (格式: MM-DD 或 MM-DD-index)
    """
    if not file_path_time_list:
        return "unknown"
    
    first_file_path, first_time = file_path_time_list[0]
    date_obj = datetime.datetime.fromtimestamp(first_time)
    date_str = date_obj.strftime('%m-%d').lstrip('0').replace('-0', '-')
    
    if group_idx is not None:
        date_str = f"{date_str}-{group_idx + 1}"
    
    return date_str

def move_existing_images_to_plan(target_dir):
    """
    检测目录中是否有图片文件，如果有则移到 '策划' 文件夹
    """
    if not os.path.exists(target_dir):
        return
    
    img_exts = ('.jpg', '.jpeg', '.png', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.heic', '.mov', '.mp4', '.avi', '.rwl', '.raf', '.3fr', '.fff')
    
    existing_files = [
        f for f in os.listdir(target_dir)
        if os.path.isfile(os.path.join(target_dir, f)) 
        and f.lower().endswith(img_exts)
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
    """
    将文件夹中的文件按类型分类到 jpg、raw、mov 子文件夹
    """
    jpg_dir = os.path.join(folder_path, "jpg")
    raw_dir = os.path.join(folder_path, "raw")
    mov_dir = os.path.join(folder_path, "mov")
    
    jpg_exts = ('.jpg', '.jpeg')
    raw_exts = ('.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', '.rwl', '.raf', '.3fr', '.fff')
    mov_exts = ('.mp4', '.mov', '.avi')
    
    try:
        for f in os.listdir(folder_path):
            file_path = os.path.join(folder_path, f)
            
            # 跳过子文件夹
            if os.path.isdir(file_path):
                continue
            
            # 判断文件类型并移动
            if f.lower().endswith(jpg_exts):
                os.makedirs(jpg_dir, exist_ok=True)
                dst = os.path.join(jpg_dir, f)
                if os.path.exists(dst):
                    name, ext = os.path.splitext(f)
                    dst = os.path.join(jpg_dir, f"{name}_{int(time.time())}{ext}")
                shutil.move(file_path, dst)
            
            elif f.lower().endswith(raw_exts):
                os.makedirs(raw_dir, exist_ok=True)
                dst = os.path.join(raw_dir, f)
                if os.path.exists(dst):
                    name, ext = os.path.splitext(f)
                    dst = os.path.join(raw_dir, f"{name}_{int(time.time())}{ext}")
                shutil.move(file_path, dst)
            
            elif f.lower().endswith(mov_exts):
                os.makedirs(mov_dir, exist_ok=True)
                dst = os.path.join(mov_dir, f)
                if os.path.exists(dst):
                    name, ext = os.path.splitext(f)
                    dst = os.path.join(mov_dir, f"{name}_{int(time.time())}{ext}")
                shutil.move(file_path, dst)
    
    except Exception as e:
        log_error(f"文件分类失败: {e}")

def copy_sd_to_dest_and_cleanup(sd_path, dest_path):
    """
    1. 复制 SD 卡文件到目标路径
    2. 删除 SD 卡文件
    返回: 复制的所有文件列表
    """
    if not os.path.exists(sd_path):
        log_error(f"SD 路径不存在: {sd_path}")
        return []
    
    log_info(f"开始复制 {sd_path} 中的文件...")
    
    valid_exts = ('.jpg', '.jpeg', '.png', '.arw', '.cr2', '.cr3', '.dng', '.nef', '.orf', 
                  '.heic', '.mp4', '.mov', '.avi')
    
    copied_files = []
    
    for root, dirs, files in os.walk(sd_path):
        for f in files:
            if f.lower().endswith(valid_exts):
                src = os.path.join(root, f)
                dst = os.path.join(dest_path, f)
                
                try:
                    # 防重名
                    if os.path.exists(dst):
                        base, ext = os.path.splitext(f)
                        dst = os.path.join(dest_path, f"{base}_{int(time.time())}{ext}")
                    
                    shutil.copy2(src, dst)
                    copied_files.append(dst)
                    log_info(f"复制: {f}")
                
                except Exception as e:
                    log_error(f"复制文件失败 {src}: {e}")
    
    # 删除 SD 卡中的文件
    if copied_files:
        log_info("删除 SD 卡中的源文件...")
        try:
            for root, dirs, files in os.walk(sd_path):
                for f in files:
                    if f.lower().endswith(valid_exts):
                        os.remove(os.path.join(root, f))
            log_success(f"成功复制并清空 SD 卡，共复制 {len(copied_files)} 个文件")
        except Exception as e:
            log_error(f"删除 SD 卡文件失败: {e}")
    
    return copied_files

def organize_photos_new(dest_path, copied_files, split_threshold_hours=2.0, should_split=None, backup_path=None):
    """
    新的组织逻辑：
    1. 检查是否需要分组
    2. 如果需要分组且用户同意，则创建多个日期文件夹
    3. 否则创建单个日期文件夹
    4. 对每个文件夹进行文件类型分类
    5. 如果有备份路径，复制处理过的文件夹到备份位置
    """
    if not copied_files:
        log_info("没有文件需要处理")
        return
    
    dest_path = os.path.abspath(dest_path)
    
    # 获取所有文件的时间信息
    files_with_time = [(f, get_file_time(f)) for f in copied_files]
    files_with_time.sort(key=lambda x: x[1])
    
    # 检查是否需要分组
    need_split, _ = has_split_needed(files_with_time, split_threshold_hours)
    
    if need_split and should_split is None:
        # 询问用户是否要分开文件夹
        ask_user("检测到照片存在2小时以上的拍摄间隔，是否要分开文件夹？", {
            "files_count": len(copied_files),
            "need_split": True
        })
        return
    
    # 决定是否真的分组
    do_split = need_split and should_split is True
    
    if do_split:
        # 按时间分组
        groups = group_files_by_time(files_with_time, split_threshold_hours)
        log_info(f"将文件分为 {len(groups)} 组处理")
        
        processed_folders = []
        
        for idx, group in enumerate(groups):
            date_name = get_group_date_name(group, idx)
            group_folder = os.path.join(dest_path, date_name)
            
            os.makedirs(group_folder, exist_ok=True)
            move_existing_images_to_plan(group_folder)
            
            # 移动文件到分组文件夹
            for file_path, _ in group:
                try:
                    filename = os.path.basename(file_path)
                    dst = os.path.join(group_folder, filename)
                    
                    if os.path.exists(dst):
                        name, ext = os.path.splitext(filename)
                        dst = os.path.join(group_folder, f"{name}_{int(time.time())}{ext}")
                    
                    shutil.move(file_path, dst)
                except Exception as e:
                    log_error(f"移动文件失败 {file_path}: {e}")
            
            # 分类文件类型
            classify_files_by_type(group_folder)
            processed_folders.append(group_folder)
            
            log_progress(f"处理: {date_name}", int((idx + 1) / len(groups) * 100))
        
        log_success(f"分类完成！处理了 {len(processed_folders)} 个分组")
    
    else:
        # 不分组，所有文件放到一个文件夹
        date_name = get_group_date_name(files_with_time)
        group_folder = os.path.join(dest_path, date_name)
        
        os.makedirs(group_folder, exist_ok=True)
        move_existing_images_to_plan(group_folder)
        
        # 移动文件到文件夹
        for file_path, _ in files_with_time:
            try:
                filename = os.path.basename(file_path)
                dst = os.path.join(group_folder, filename)
                
                if os.path.exists(dst):
                    name, ext = os.path.splitext(filename)
                    dst = os.path.join(group_folder, f"{name}_{int(time.time())}{ext}")
                
                shutil.move(file_path, dst)
            except Exception as e:
                log_error(f"移动文件失败 {file_path}: {e}")
        
        # 分类文件类型
        classify_files_by_type(group_folder)
        
        log_success(f"分类完成！所有文件已移到: {date_name}")
    
    # 备份逻辑
    if backup_path and os.path.exists(backup_path):
        log_info("开始备份处理过的文件夹...")
        try:
            if do_split:
                groups = group_files_by_time(files_with_time, split_threshold_hours)
                for idx, group in enumerate(groups):
                    date_name = get_group_date_name(group, idx)
                    src_folder = os.path.join(dest_path, date_name)
                    backup_folder = os.path.join(backup_path, date_name)
                    if os.path.exists(src_folder):
                        shutil.copytree(src_folder, backup_folder, dirs_exist_ok=True)
            else:
                date_name = get_group_date_name(files_with_time)
                src_folder = os.path.join(dest_path, date_name)
                backup_folder = os.path.join(backup_path, date_name)
                if os.path.exists(src_folder):
                    shutil.copytree(src_folder, backup_folder, dirs_exist_ok=True)
            
            log_success("备份完成")
        except Exception as e:
            log_error(f"备份失败: {e}")

# --- 阶段处理函数 ---

def stage_check(sd_path):
    """检查 SD 卡是否存在"""
    if os.path.exists(sd_path):
        log_status("SD Card Detected", {"connected": True, "path": sd_path})
    else:
        log_status("No Device", {"connected": False})

def stage_import_and_organize(sd_path, dest_path, backup_path=None, split_threshold_hours=2.0, should_split=None):
    """
    新的导入和组织流程
    """
    if not os.path.exists(dest_path):
        try:
            os.makedirs(dest_path)
        except Exception as e:
            log_error(f"无法创建目标路径: {e}")
            return
    
    # 复制并清空 SD 卡
    copied_files = copy_sd_to_dest_and_cleanup(sd_path, dest_path)
    
    if not copied_files:
        log_error("没有文件被复制")
        return
    
    # 组织和分类文件
    organize_photos_new(dest_path, copied_files, split_threshold_hours, should_split, backup_path)

# --- 主入口 ---

def run(args_list):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')

    username = os.getenv('USERNAME') or 'user'
    
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True, choices=['check', 'import'], help="运行阶段")
    parser.add_argument("--sd_path", default="H:/DCIM", help="SD卡路径")
    parser.add_argument("--dest_path", default=f"C:/Users/{username}/Desktop", help="目标路径")
    parser.add_argument("--backup_path", default="", help="备份路径")
    parser.add_argument("--time_gap", type=float, default=2.0, help="时间分组阈值(小时)")
    parser.add_argument("--should_split", type=str, default="", help="是否分组 (true/false/空)")

    args = parser.parse_args(args_list)

    sd_path = args.sd_path.strip('"')
    dest_path = args.dest_path.strip('"')
    backup_path = args.backup_path.strip('"') if args.backup_path else None
    should_split = None if not args.should_split else args.should_split.lower() == 'true'

    try:
        if args.stage == 'check':
            stage_check(sd_path)
        elif args.stage == 'import':
            stage_import_and_organize(sd_path, dest_path, backup_path, args.time_gap, should_split)
    except Exception as e:
        log_error(f"脚本运行异常: {str(e)}")

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")