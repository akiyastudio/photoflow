import os
import shutil
import sys
import json
import argparse

# --- Electron 通信辅助函数 ---
def emit(event_type, message, data=None, progress=None):
    payload = {"type": event_type, "message": message}
    if data is not None: payload["data"] = data
    if progress is not None: payload["progress"] = progress
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def log_info(msg): emit('log', msg)
def log_success(msg): emit('success', msg)
def log_error(msg): emit('error', msg)

def run(args_list):
    # 解决 Windows 中文输出乱码
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="源文件夹路径")
    parser.add_argument("--keywords", nargs='+', required=True, help="文件名关键词列表")
    parser.add_argument("--dest_name", default="1", help="目标文件夹名称") 
    args = parser.parse_args(args_list) 

    # 1. 获取并清理源路径
    source_dir = args.source.strip().strip('"').strip("'")
    search_names = args.keywords

    if not os.path.exists(source_dir):
        log_error(f"源文件夹不存在: {source_dir}")
        return

    # 2. 自动设定目标文件夹
    try:
        abs_source_dir = os.path.abspath(source_dir)
        parent_dir = os.path.dirname(abs_source_dir)
        target_dir = os.path.join(parent_dir, args.dest_name)

        if not os.path.exists(target_dir):
            os.makedirs(target_dir)
            log_info(f"已创建目标文件夹: {target_dir}")
        else:
            log_info(f"目标文件夹已存在: {target_dir}")
    except Exception as e:
        log_error(f"创建目标文件夹失败: {e}")
        return

    # 3. 遍历并复制文件
    log_info(f"开始搜索关键词: {', '.join(search_names)}")
    count = 0
    
    for root, _, files in os.walk(source_dir):
        # 忽略目标文件夹本身，防止递归死循环
        if os.path.abspath(root).startswith(os.path.abspath(target_dir)):
            continue

        for file in files:
            # 核心匹配逻辑：只要文件名包含关键词，就匹配成功
            for name in search_names:
                if name in file:
                    source_path = os.path.join(root, file)
                    target_path = os.path.join(target_dir, file)
                    
                    try:
                        shutil.copy2(source_path, target_path)
                        log_info(f"复制: {file}")
                        count += 1
                    except Exception as e:
                        log_error(f"复制失败 {file}: {e}")
                    
                    # 找到一个匹配项后跳出内层循环，避免重复处理
                    break
    
    if count == 0:
        log_info("未找到包含指定关键词的文件。")
    else:
        emit('success', f"处理完成，共复制 {count} 个文件到文件夹 '{args.dest_name}'。")

if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")