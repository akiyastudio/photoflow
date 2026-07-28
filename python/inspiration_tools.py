"""Dispatcher for the visual tools bundled with PhotoFlow's core app."""

import importlib
import sys


TOOLS = {
    "research": "research",
    "office_media_extract": "office_media_extract",
}


def main(args_list):
    if not args_list:
        raise SystemExit("请指定灵感库工具名称")
    tool_name, *tool_args = args_list
    tool_name = tool_name.removesuffix(".py")
    try:
        module_name = TOOLS[tool_name]
    except KeyError:
        raise SystemExit(f"未知灵感库工具：{tool_name}") from None
    importlib.import_module(module_name).run(tool_args)


if __name__ == "__main__":
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    main(sys.argv[1:])
