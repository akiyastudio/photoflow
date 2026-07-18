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
    parser.add_argument('--cover_only', action='store_true')
    parser.add_argument('--remaining_only', action='store_true')
    args = parser.parse_args(arguments)

    source_path = os.path.abspath(args.source)
    if not os.path.isfile(source_path):
        raise RuntimeError('视频文件不存在')
    os.makedirs(args.output_dir, exist_ok=True)

    ffmpeg_exe = get_ffmpeg_exe()
    duration = probe_duration(ffmpeg_exe, source_path)
    points = (0.08, 0.28, 0.50, 0.72, 0.90)
    frame_paths = []
    # Large grid tiles need a genuinely larger source image; scaling a cached
    # 640 px frame in the renderer makes zoomed video previews visibly soft.
    size = max(320, min(1600, args.size))

    cover_path = os.path.join(args.output_dir, f'{args.cache_key}-1.jpg')
    if args.remaining_only:
        if not os.path.isfile(cover_path):
            raise RuntimeError('视频代表帧缓存不存在')
    else:
        cover_timestamp = max(0, min(duration - 0.05, duration * points[0]))
        cover_result = subprocess.run(
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
        if cover_result.returncode != 0 or not os.path.isfile(cover_path):
            raise RuntimeError(cover_result.stderr.strip() or '视频代表帧生成失败')
    frame_paths.append(cover_path)
    print(json.dumps({'duration': duration, 'frames': list(frame_paths), 'complete': False}, ensure_ascii=False), flush=True)
    if args.cover_only:
        return

    command = [ffmpeg_exe, '-hide_banner', '-loglevel', 'error', '-y']
    for point in points[1:]:
        timestamp = max(0, min(duration - 0.05, duration * point))
        command.extend(['-ss', f'{timestamp:.3f}', '-i', source_path])

    remaining_paths = []
    for input_index, _point in enumerate(points[1:]):
        index = input_index + 2
        output_path = os.path.join(args.output_dir, f'{args.cache_key}-{index}.jpg')
        remaining_paths.append(output_path)
        command.extend([
            '-map', f'{input_index}:v:0', '-frames:v', '1',
            '-vf', f'scale={size}:{size}:force_original_aspect_ratio=decrease',
            '-q:v', '4', output_path,
        ])

    result = subprocess.run(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    if result.returncode != 0 or not all(os.path.isfile(frame) for frame in remaining_paths):
        raise RuntimeError(result.stderr.strip() or '视频抽样帧生成失败')
    frame_paths.extend(remaining_paths)

    print(json.dumps({'duration': duration, 'frames': frame_paths, 'complete': True}, ensure_ascii=False), flush=True)


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
