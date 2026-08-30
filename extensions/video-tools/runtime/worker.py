import argparse
import base64
import json
import os
import sys


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def cancelled(path):
    return bool(path and os.path.exists(path))


def bridge(encoded):
    payload = json.loads(base64.urlsafe_b64decode(encoded.encode('ascii')).decode('utf-8'))
    action = str(payload.get('action') or '')
    from ffmpeg_transcode import (
        probe_creation_time_values,
        split_video_by_size,
        transcode_video,
        transcode_video_preview,
    )
    cancel_file = str(payload.get('cancelFile') or '')
    check = lambda: (_ for _ in ()).throw(RuntimeError('任务已取消')) if cancelled(cancel_file) else None
    if action == 'probe-creation-time':
        result = {'values': list(probe_creation_time_values(payload['inputPath']))}
    elif action == 'preview':
        encoder = transcode_video_preview(payload['inputPath'], payload['outputPath'], payload.get('quality', 'medium'))
        result = {'encoder': encoder, 'outputPath': payload['outputPath']}
    elif action == 'split':
        outputs = split_video_by_size(
            payload['inputPath'],
            split_threshold_bytes=int(payload.get('splitThresholdBytes') or 0) or None,
            target_segment_bytes=int(payload.get('targetSegmentBytes') or 0) or None,
            maximum_segment_bytes=int(payload.get('maximumSegmentBytes') or 0) or None,
            keep_original=payload.get('keepOriginal') is True,
            cancel_check=check,
        )
        result = {'outputs': outputs}
    elif action == 'transcode':
        settings = dict(payload.get('settings') or {})
        result_path = transcode_video(
            payload['inputPath'],
            container=settings.get('container', 'mp4'), video_mode=settings.get('videoMode', 'h264'),
            quality=settings.get('quality', 'balanced'), resolution=settings.get('resolution', 'original'),
            frame_rate=settings.get('frameRate', 'original'), audio_mode=settings.get('audioMode', 'aac'),
            subtitle_mode=settings.get('subtitleMode', 'copy'), color_mode=settings.get('colorMode', 'auto'),
            bit_depth=settings.get('bitDepth', 'auto'), frame_rate_mode=settings.get('frameRateMode', 'preserve'),
            rotation=settings.get('rotation', 'auto'), aspect_mode=settings.get('aspectMode', 'preserve'),
            audio_track=settings.get('audioTrack', 'all'), video_bitrate_mbps=settings.get('videoBitrateMbps'),
            audio_bitrate_kbps=settings.get('audioBitrateKbps', 192), encoder_preset=settings.get('encoderPreset', 'balanced'),
            output_mode=payload.get('outputMode', 'new'), destination_directory=payload.get('destinationDirectory'),
            cancel_check=check,
        )
        result = {'outputPath': result_path}
    elif action == 'frame':
        import subprocess
        ffmpeg_exe = __import__('ffmpeg_utils').get_ffmpeg_exe()
        command = [ffmpeg_exe, '-hide_banner', '-loglevel', 'error']
        if os.path.splitext(payload['inputPath'])[1].lower() in {'.mp4', '.mov', '.avi', '.m4v', '.mkv', '.webm', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm'}:
            command.extend(['-ss', '0.2'])
        command.extend(['-i', payload['inputPath'], '-frames:v', '1', '-vf', 'scale=640:-2', '-y', payload['outputPath']])
        completed = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
        if completed.returncode != 0 or not os.path.isfile(payload['outputPath']):
            raise RuntimeError(completed.stderr.decode('utf-8', errors='replace').strip() or '无法提取媒体画面')
        result = {'outputPath': payload['outputPath']}
    else:
        raise ValueError(f'Unknown bridge action: {action}')
    emit({'type': 'success', 'success': True, 'result': result})


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('tool')
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    parsed = parser.parse_args()
    if parsed.tool == 'bridge':
        bridge(parsed.arguments[0])
        return 0
    if parsed.tool == 'ffmpeg_transcode':
        from ffmpeg_transcode import run
        return run(parsed.arguments)
    if parsed.tool == 'cut_video':
        from cut_video import run
        return run(parsed.arguments)
    if parsed.tool == 'video_preview':
        from video_preview import run
        run(parsed.arguments)
        return 0
    raise ValueError(f'Unknown video tools action: {parsed.tool}')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        emit({'type': 'error', 'success': False, 'message': str(error)})
        raise SystemExit(1)
