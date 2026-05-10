import os
import shutil
import sys
import json
import argparse
import re

# --- Electron 通信辅助函数 ---
def emit(event_type, message, data=None, progress=None):
    payload = {"type": event_type, "message": message}
    if data is not None: payload["data"] = data
    if progress is not None: payload["progress"] = progress
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def log_info(msg): emit('log', msg)
def log_success(msg): emit('success', msg)
def log_error(msg): emit('error', msg)

def process_files(source_dir, target_dir, search_names):
    """
    负责执行最终的遍历、比对、复制文件的逻辑
    """
    if not os.path.exists(source_dir):
        log_error(f"源文件夹不存在: {source_dir}")
        return

    # 自动设定目标文件夹
    try:
        if not os.path.exists(target_dir):
            os.makedirs(target_dir)
            log_info(f"已创建目标文件夹: {target_dir}")
        else:
            log_info(f"目标文件夹已存在: {target_dir}")
    except Exception as e:
        log_error(f"创建目标文件夹失败: {e}")
        return

    log_info(f"开始搜索关键词: {', '.join(search_names)}")
    
    found_keywords = set()  
    count = 0               
    skip_count = 0          
    
    for root, _, files in os.walk(source_dir):
        if os.path.abspath(root).startswith(os.path.abspath(target_dir)):
            continue

        for file in files:
            for name in search_names:
                if name in file:
                    found_keywords.add(name)
                    source_path = os.path.join(root, file)
                    target_path = os.path.join(target_dir, file)
                    
                    if os.path.exists(target_path):
                        log_info(f"跳过: {file} (目标目录已存在同名文件)")
                        skip_count += 1
                        break 
                    
                    try:
                        shutil.copy2(source_path, target_path)
                        log_info(f"复制: {file}")
                        count += 1
                    except Exception as e:
                        log_error(f"复制失败 {file}: {e}")
                    
                    break 
    
    # 结果反馈逻辑
    not_found = [n for n in search_names if n not in found_keywords]
    
    if not_found:
        log_info(f"提示：以下关键词未找到任何匹配文件: {', '.join(not_found)}")

    result_msg = f"处理完成。成功复制: {count} 个"
    if skip_count > 0:
        result_msg += f"，跳过同名文件: {skip_count} 个"
    
    if count == 0 and skip_count == 0:
        log_error("未找到任何包含指定关键词的文件。")
    else:
        if not_found:
            result_msg += f" (注：有 {len(not_found)} 个关键词未命中)"
        emit('success', result_msg)

# ==========================================
# 模式一：新逻辑 - 智能提取连续数字作为关键词
# ==========================================
def run_extract_numbers(args_list):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="源文件夹路径")
    parser.add_argument("--keywords", nargs='+', required=True, help="包含数字的混合文本")
    parser.add_argument("--dest_name", default="1", help="目标文件夹名称") 
    args = parser.parse_args(args_list) 

    source_dir = args.source.strip().strip('"').strip("'")
    
    # 1. 把传入的参数全拼成一个长字符串（应对中间有空格、换行等情况）
    raw_text = " ".join(args.keywords)
    
    # 2. 核心正则切割提取：\d+ 代表“匹配一段连续的1个或多个数字”
    # 如果文本是 "7380/7381 7404编辫子\n测试"，结果将是['7380', '7381', '7404']
    extracted_numbers = re.findall(r'\d{3,}', raw_text)
    
    # 3. 去重，并保持原有的先后顺序
    search_names = list(dict.fromkeys(extracted_numbers))

    if not search_names:
        log_error("未从输入内容中提取到任何数字作为关键词。")
        return

    # 4. 生成目标路径并调用公共逻辑
    abs_source_dir = os.path.abspath(source_dir)
    parent_dir = os.path.dirname(abs_source_dir)
    target_dir = os.path.join(parent_dir, args.dest_name)
    
    process_files(source_dir, target_dir, search_names)

# ==========================================
# 模式二：旧逻辑 - 原封不动保留（作为独立函数）
# ==========================================
def run_original(args_list):
    if sys.platform.startswith('win'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="源文件夹路径")
    parser.add_argument("--keywords", nargs='+', required=True, help="文件名关键词列表")
    parser.add_argument("--dest_name", default="1", help="目标文件夹名称") 
    args = parser.parse_args(args_list) 

    source_dir = args.source.strip().strip('"').strip("'")
    search_names = args.keywords

    abs_source_dir = os.path.abspath(source_dir)
    parent_dir = os.path.dirname(abs_source_dir)
    target_dir = os.path.join(parent_dir, args.dest_name)

    # 直接使用原始关键词调用公共逻辑
    process_files(source_dir, target_dir, search_names)

if __name__ == "__main__":
    try:
        run_extract_numbers(sys.argv[1:])
    except Exception as e:
        log_error(f"脚本运行出错: {str(e)}")