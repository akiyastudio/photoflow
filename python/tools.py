import sys

import catch
import classify
import cut_video
import png_to_jpg
import rename
import research
import video_preview


TOOLS = {
    "catch": catch.run,
    "classify": classify.run,
    "cut_video": cut_video.run,
    "png_to_jpg": png_to_jpg.run,
    "rename": rename.run,
    "research": research.run,
    "video_preview": video_preview.run,
}


def main(args_list):
    if not args_list:
        raise SystemExit("请指定工具名称")

    tool_name, *tool_args = args_list
    tool_name = tool_name.removesuffix(".py")
    try:
        run_tool = TOOLS[tool_name]
    except KeyError:
        raise SystemExit(f"未知工具：{tool_name}") from None
    run_tool(tool_args)


if __name__ == "__main__":
    main(sys.argv[1:])
