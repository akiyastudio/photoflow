import argparse
import json
import os
import re
import subprocess
import sys

from ffmpeg_utils import get_ffmpeg_exe


def probe_duration(ffmpeg_exe, source_path):
    result = subprocess.run(
        [ffmpeg_exe, '-hide_banner', '-i', source_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    match = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', result.stderr)
    if not match:
        raise RuntimeError('无法读取视频时长')
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def run(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output_dir', required=True)
    parser.add_argument('--cache_key', required=True)
    parser.add_argument('--size', type=int, default=640)
    args = parser.parse_args(arguments)

    source_path = os.path.abspath(args.source)
    if not os.path.isfile(source_path):
        raise RuntimeError('视频文件不存在')
    os.makedirs(args.output_dir, exist_ok=True)

    ffmpeg_exe = get_ffmpeg_exe()
    duration = probe_duration(ffmpeg_exe, source_path)
    # Large grid tiles need a genuinely larger source image; scaling a cached
    # 640 px frame in the renderer makes zoomed video previews visibly soft.
    size = max(320, min(1600, args.size))

    cover_path = os.path.join(args.output_dir, f'{args.cache_key}-1.jpg')
    cover_timestamp = max(0, min(duration - 0.05, duration * 0.08))
    result = subprocess.run(
        [
            ffmpeg_exe, '-hide_banner', '-loglevel', 'error', '-y',
            '-ss', f'{cover_timestamp:.3f}', '-i', source_path,
            '-frames:v', '1', '-vf', f'scale={size}:{size}:force_original_aspect_ratio=decrease',
            '-q:v', '4', cover_path,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    if result.returncode != 0 or not os.path.isfile(cover_path):
        raise RuntimeError(result.stderr.strip() or '视频代表帧生成失败')

    print(json.dumps({'duration': duration, 'frames': [cover_path]}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    # Electron decodes the JSONL response as UTF-8. Explicitly override the
    # Windows console code page so custom cache paths remain valid too.
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='strict')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    try:
        run(sys.argv[1:])
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), flush=True)
        raise SystemExit(1)
