import os
import json
import sys

def get_user_path():
    """返回当前用户的主目录路径"""
    username = os.getenv('USERNAME') or 'user'
    # 统一使用正斜杠，防止 JSON 转义问题
    return f"C:/Users/{username}".replace("\\", "/")

# 保持这个 block，以便开发环境单独测试
if __name__ == "__main__":
    try:
        user_path = get_user_path()
        print(json.dumps({"userPath": user_path}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))