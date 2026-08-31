import datetime
import contextlib
import errno
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest import mock

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'extensions' / 'video-tools' / 'runtime'))
sys.path.insert(0, str(ROOT / 'python'))

import classify  # noqa: E402
import ffmpeg_transcode  # noqa: E402
import workspace_db  # noqa: E402

FAKE_MP4_BYTES = b'\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42'


class ClassifyImportTests(unittest.TestCase):
    def test_video_tool_request_uses_host_protocol(self):
        emitted = []
        response = json.dumps({"type": "video_tool_result", "requestId": "video-1", "ok": True, "result": {"values": ["2026-08-29T12:00:00Z"]}}) + "\n"
        previous_protocol = classify.RESOURCE_PROTOCOL_ENABLED
        previous_sequence = classify.VIDEO_TOOL_REQUEST_SEQUENCE
        try:
            classify.RESOURCE_PROTOCOL_ENABLED = True
            classify.VIDEO_TOOL_REQUEST_SEQUENCE = 0
            with mock.patch.object(classify, 'emit', side_effect=lambda event_type, message, data=None, **_extra: emitted.append((event_type, message, data))), mock.patch.object(classify.sys, 'stdin', io.StringIO(response)):
                values = classify.probe_creation_time_values('clip.mov')
            self.assertEqual(values, ('2026-08-29T12:00:00Z',))
            self.assertEqual(emitted[0][0], 'video_tool_request')
            self.assertEqual(emitted[0][2]['action'], 'probe-creation-time')
        finally:
            classify.RESOURCE_PROTOCOL_ENABLED = previous_protocol
            classify.VIDEO_TOOL_REQUEST_SEQUENCE = previous_sequence

    def test_video_tool_request_times_out_when_host_stops_responding(self):
        release = threading.Event()

        class BlockingControlStream:
            def readline(self):
                release.wait(1)
                return ''

        classify.RESOURCE_PROTOCOL_ENABLED = True
        with mock.patch.object(classify.sys, 'stdin', BlockingControlStream()), \
                mock.patch.object(classify, 'HOST_VIDEO_TOOL_IDLE_TIMEOUT_SECONDS', 0.02), \
                mock.patch.object(classify, 'HOST_CONTROL_POLL_SECONDS', 0.005), \
                mock.patch.object(classify, 'emit'):
            try:
                with self.assertRaisesRegex(classify.FFmpegTranscodeError, '长时间未响应'):
                    classify.request_video_tool('transcode', {'inputPath': 'clip.mov'})
            finally:
                release.set()

    def test_resource_wait_observes_import_cancellation(self):
        release = threading.Event()

        class BlockingControlStream:
            def readline(self):
                release.wait(1)
                return ''

        with tempfile.TemporaryDirectory() as temporary:
            cancel_file = Path(temporary) / 'cancel.flag'
            cancel_file.write_text('cancel', encoding='utf-8')
            classify.CANCEL_FILE = str(cancel_file)
            classify.RESOURCE_PROTOCOL_ENABLED = True
            with mock.patch.object(classify.sys, 'stdin', BlockingControlStream()), \
                    mock.patch.object(classify, 'emit'):
                try:
                    with self.assertRaisesRegex(classify.ImportCancelled, '导入已取消'):
                        with classify.task_resource_lease('video-transcode', '正在转码视频'):
                            self.fail('取消后不得进入视频处理阶段')
                finally:
                    release.set()

    def tearDown(self):
        classify.CANCEL_FILE = ''
        classify.EXIFTOOL_PATH = ''
        classify.RESOURCE_PROTOCOL_ENABLED = False
        classify.CAPTURE_TIME_MEMORY_CACHE.clear()
        classify.get_file_time.cache_clear()

    def test_phase_resource_lease_waits_for_host_grant_and_releases(self):
        lease_uuid = '00000000-0000-0000-0000-000000000001'
        lease_id = f'lease-{lease_uuid}'
        control = io.StringIO(json.dumps({'type': 'resource_granted', 'leaseId': lease_id}) + '\n')
        events = []
        classify.RESOURCE_PROTOCOL_ENABLED = True
        with mock.patch.object(classify.uuid, 'uuid4', return_value=lease_uuid), \
                mock.patch.object(classify.sys, 'stdin', control), \
                mock.patch.object(classify, 'emit', side_effect=lambda event_type, message, data=None, **_kwargs: events.append((event_type, message, data))):
            with classify.task_resource_lease('video-split', '正在分割视频'):
                events.append(('worker', 'started', None))

        self.assertEqual([event[0] for event in events], ['resource_request', 'worker', 'resource_release'])
        self.assertEqual(events[0][2], {'leaseId': lease_id, 'profile': 'video-split', 'phase': '正在分割视频'})
        self.assertEqual(events[-1][2]['leaseId'], lease_id)

    def test_phase_resource_wait_heartbeat_prevents_false_timeout(self):
        lease_uuid = '00000000-0000-0000-0000-000000000003'
        lease_id = f'lease-{lease_uuid}'
        control = io.StringIO(
            json.dumps({'type': 'resource_waiting', 'leaseId': lease_id}) + '\n'
            + json.dumps({'type': 'resource_granted', 'leaseId': lease_id}) + '\n'
        )
        classify.RESOURCE_PROTOCOL_ENABLED = True
        with mock.patch.object(classify.uuid, 'uuid4', return_value=lease_uuid), \
                mock.patch.object(classify.sys, 'stdin', control), \
                mock.patch.object(classify, 'emit'):
            with classify.task_resource_lease('video-transcode', '等待视频资源'):
                pass

    def test_phase_resource_lease_never_runs_after_host_denial(self):
        lease_uuid = '00000000-0000-0000-0000-000000000002'
        lease_id = f'lease-{lease_uuid}'
        control = io.StringIO(json.dumps({'type': 'resource_denied', 'leaseId': lease_id, 'error': '资源不可用'}) + '\n')
        classify.RESOURCE_PROTOCOL_ENABLED = True
        with mock.patch.object(classify.uuid, 'uuid4', return_value=lease_uuid), \
                mock.patch.object(classify.sys, 'stdin', control), \
                mock.patch.object(classify, 'emit'):
            with self.assertRaisesRegex(classify.ResourceLeaseDenied, '资源不可用'):
                with classify.task_resource_lease('video-split', '正在分割视频'):
                    self.fail('未授权时不得执行阶段工作')

    def test_capture_time_prefers_exif_over_filesystem_mtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'photo.jpg'
            exif = Image.Exif()
            exif[36867] = '2024:05:06 07:08:09'
            Image.new('RGB', (8, 8), 'white').save(source, exif=exif)
            filesystem_time = datetime.datetime(2030, 1, 2, 3, 4, 5).timestamp()
            os.utime(source, (filesystem_time, filesystem_time))

            actual = classify.get_file_time(str(source))
            expected = datetime.datetime(2024, 5, 6, 7, 8, 9).timestamp()
            self.assertEqual(actual, expected)

    def test_video_capture_time_prefers_embedded_creation_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mp4'
            source.write_bytes(b'video')
            filesystem_time = datetime.datetime(2030, 1, 2, 3, 4, 5).timestamp()
            os.utime(source, (filesystem_time, filesystem_time))
            with mock.patch.object(classify, 'probe_creation_time_values', return_value=('2024-05-06T07:08:09Z',)):
                actual = classify.get_file_time(str(source))

            expected = datetime.datetime(2024, 5, 6, 7, 8, 9, tzinfo=datetime.timezone.utc).timestamp()
            self.assertEqual(actual, expected)

    def test_implausible_video_capture_time_falls_back_to_filesystem_mtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mp4'
            source.write_bytes(b'video')
            filesystem_time = datetime.datetime(2025, 4, 3, 2, 1).timestamp()
            os.utime(source, (filesystem_time, filesystem_time))
            classify.get_file_time.cache_clear()
            with mock.patch.object(classify, 'probe_creation_time_values', return_value=('2999-01-01T00:00:00Z',)):
                self.assertEqual(classify.get_file_time(str(source)), filesystem_time)

    def test_unknown_stage_emits_error_protocol_event(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), mock.patch.object(classify.sys, 'platform', 'linux'):
            classify.run(['--stage', 'mystery'])
        events = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith('{')]
        self.assertEqual(events[-1]['type'], 'error')
        self.assertIn('未知导入阶段', events[-1]['message'])

    def test_ffmpeg_metadata_probe_orders_creation_time_fields(self):
        metadata = """
            creation_time : 2024-05-06T07:08:09Z
            com.apple.quicktime.creationdate : 2024-05-06T06:00:00Z
            date : 2024-05-05
        """
        with mock.patch.object(ffmpeg_transcode, 'probe_media_text', return_value=metadata):
            values = ffmpeg_transcode.probe_creation_time_values('clip.mov')
        self.assertEqual(values, (
            '2024-05-06T06:00:00Z',
            '2024-05-06T07:08:09Z',
            '2024-05-05',
        ))

    def test_all_date_filter_skips_capture_time_pre_scan(self):
        files = ['one.jpg', 'two.mp4']
        with mock.patch.object(classify, 'get_file_time', side_effect=AssertionError('all imports must not pre-read metadata')):
            selected, capture_times = classify.filter_media_by_capture_date(files, 'all')
        self.assertEqual(selected, files)
        self.assertEqual(capture_times, {})

    def test_capture_times_use_one_exiftool_batch_and_task_memory_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = [root / 'one.jpg', root / 'two.mp4']
            for source in files:
                source.write_bytes(b'media')
            exiftool = root / 'exiftool.exe'
            exiftool.write_bytes(b'executable-placeholder')
            classify.EXIFTOOL_PATH = str(exiftool)
            timestamps = [datetime.datetime(2026, 8, 1, 12).timestamp(), datetime.datetime(2026, 8, 2, 12).timestamp()]
            response = mock.Mock(returncode=0, stderr='', stdout=json.dumps([
                {'SourceFile': str(files[0]), 'EXIF:DateTimeOriginal': timestamps[0]},
                {'SourceFile': str(files[1]), 'QuickTime:MediaCreateDate': timestamps[1]},
            ]))

            with mock.patch.object(classify.subprocess, 'run', return_value=response) as run:
                first = classify.capture_times_for_files([str(path) for path in files])
            self.assertEqual([timestamp for _path, timestamp in first], timestamps)
            run.assert_called_once()

            with mock.patch.object(classify.subprocess, 'run', side_effect=AssertionError('cache hit must not start ExifTool')):
                second = classify.capture_times_for_files([str(path) for path in files])
            self.assertEqual(second, first)

    def test_today_and_yesterday_filter_runs_before_staging_and_caches_times(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            dcim.mkdir(parents=True)
            sources = [dcim / 'today.jpg', dcim / 'yesterday.jpg', dcim / 'old.jpg']
            for source in sources:
                source.write_bytes(source.name.encode('utf-8'))
            today = datetime.date.today()
            capture_times = {
                os.path.normcase(os.path.abspath(str(sources[0]))): datetime.datetime.combine(today, datetime.time(12)).timestamp(),
                os.path.normcase(os.path.abspath(str(sources[1]))): datetime.datetime.combine(today - datetime.timedelta(days=1), datetime.time(12)).timestamp(),
                os.path.normcase(os.path.abspath(str(sources[2]))): datetime.datetime.combine(today - datetime.timedelta(days=2), datetime.time(12)).timestamp(),
            }

            with mock.patch.object(classify, 'get_file_time', side_effect=lambda path: capture_times[os.path.normcase(os.path.abspath(path))]) as capture_time:
                staged = classify.stage_media_to_safety_temp(
                    str(root / 'card'),
                    str(root),
                    import_session='date-filter',
                    date_filter='today_yesterday',
                )

            self.assertEqual(capture_time.call_count, 3)
            self.assertEqual({Path(path).name for path in staged['originalFiles']}, {'today.jpg', 'yesterday.jpg'})
            self.assertEqual({Path(path).name for path in staged['stagedFiles']}, {'today.jpg', 'yesterday.jpg'})
            self.assertEqual(len(staged['timedFiles']), 2)
            self.assertEqual(staged['sourceFileCount'], 3)
            self.assertEqual(staged['dateFilter'], 'today_yesterday')
            self.assertFalse(any(Path(path).name == 'old.jpg' for path in staged['stagedFiles']))

            with mock.patch.object(classify, 'get_file_time', side_effect=AssertionError('filtered capture times must be reused')):
                self.assertEqual(classify.staged_files_with_capture_times(staged), staged['timedFiles'])

    def test_staging_resumes_completed_files_after_source_disconnect(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            card = root / 'card'
            destination = root / 'workspace'
            card.mkdir()
            destination.mkdir()
            sources = [card / 'one.jpg', card / 'two.jpg']
            sources[0].write_bytes(b'first-file')
            sources[1].write_bytes(b'second-file')
            original_copy = classify.safe_chunk_copy

            def disconnect_on_second(source, target, chunk_size=4 * 1024 * 1024, on_progress=None, collect_digest=False):
                if Path(source).name == 'two.jpg':
                    Path(target).write_bytes(b'partial')
                    raise OSError('device disconnected')
                return original_copy(source, target, chunk_size, on_progress, collect_digest)

            with mock.patch.object(classify, 'scan_import_media', return_value=(str(card), [str(path) for path in sources])), \
                    mock.patch.object(classify, 'safe_chunk_copy', side_effect=disconnect_on_second):
                with self.assertRaises(OSError):
                    classify.stage_media_to_safety_temp(str(card), str(destination), import_session='resume-card')

            with mock.patch.object(classify, 'scan_import_media', return_value=(str(card), [str(path) for path in sources])), \
                    mock.patch.object(classify, 'safe_chunk_copy', wraps=original_copy) as resumed_copy:
                staged = classify.stage_media_to_safety_temp(str(card), str(destination), import_session='resume-card')

            self.assertEqual(resumed_copy.call_count, 1)
            self.assertEqual(Path(resumed_copy.call_args.args[0]).name, 'two.jpg')
            self.assertEqual(len(staged['stagedFiles']), 2)
            self.assertTrue(all(Path(path).is_file() for path in staged['stagedFiles']))

    def test_video_preview_prefers_gpu_and_falls_back_to_cpu(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mov'
            output = Path(temporary) / 'clip-preview.mp4'
            source.write_bytes(b'video')
            failed_gpu = mock.Mock(returncode=1, stderr='no compatible GPU')
            succeeded_cpu = mock.Mock(returncode=0, stderr='')

            with mock.patch.object(ffmpeg_transcode, 'get_ffmpeg_exe', return_value='ffmpeg'), \
                    mock.patch.object(ffmpeg_transcode.subprocess, 'run', side_effect=[failed_gpu, failed_gpu, succeeded_cpu]) as run:
                encoder = ffmpeg_transcode.transcode_video_preview(
                    str(source),
                    str(output),
                    encoder_candidates=['h264_nvenc', 'libx264'],
                )

            self.assertEqual(encoder, 'libx264')
            self.assertEqual(run.call_count, 3)
            self.assertIn('h264_nvenc', run.call_args_list[0].args[0])
            self.assertIn('-hwaccel', run.call_args_list[0].args[0])
            self.assertNotIn('-hwaccel', run.call_args_list[1].args[0])
            self.assertIn('libx264', run.call_args_list[2].args[0])

    def test_general_video_transcode_builds_crf_and_remux_commands(self):
        command = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'clip.mov', 'clip.mp4',
            container='mp4', video_mode='h264', quality='high',
            resolution='1080p', frame_rate='30', audio_mode='aac',
        )
        self.assertIn('libx264', command)
        self.assertEqual(command[command.index('-crf') + 1], '18')
        self.assertIn('fps=30', command[command.index('-vf') + 1])
        self.assertIn('min(1920,iw)', command[command.index('-vf') + 1])
        self.assertIn('+faststart', command)

        nvenc = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'clip.mov', 'clip.mp4',
            container='mp4', video_mode='h264', quality='balanced',
            resolution='1080p', frame_rate='original', audio_mode='aac',
            encoder='h264_nvenc',
        )
        self.assertEqual(nvenc[nvenc.index('-c:v') + 1], 'h264_nvenc')
        self.assertEqual(nvenc[nvenc.index('-cq') + 1], '22')
        self.assertNotIn('libx264', nvenc)

        hevc_cpu = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'clip.mov', 'clip.mp4',
            container='mp4', video_mode='h265', quality='balanced',
            resolution='original', frame_rate='original', audio_mode='aac',
        )
        self.assertEqual(hevc_cpu[hevc_cpu.index('-c:v') + 1], 'libx265')
        self.assertEqual(hevc_cpu[hevc_cpu.index('-crf') + 1], '25')
        self.assertEqual(hevc_cpu[hevc_cpu.index('-tag:v') + 1], 'hvc1')

        hevc_nvenc = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'clip.mov', 'clip.mkv',
            container='mkv', video_mode='h265', quality='high',
            resolution='original', frame_rate='original', audio_mode='copy',
            encoder='hevc_nvenc',
        )
        self.assertEqual(hevc_nvenc[hevc_nvenc.index('-c:v') + 1], 'hevc_nvenc')
        self.assertEqual(hevc_nvenc[hevc_nvenc.index('-cq') + 1], '21')
        self.assertNotIn('-tag:v', hevc_nvenc)

        remux = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'clip.mov', 'clip.mkv',
            container='mkv', video_mode='copy', quality='balanced',
            resolution='original', frame_rate='original', audio_mode='remove',
        )
        self.assertEqual(remux[remux.index('-c:v') + 1], 'copy')
        self.assertIn('-an', remux)
        self.assertNotIn('-vf', remux)
        self.assertNotIn('-movflags', remux)

        with self.assertRaisesRegex(ValueError, '不能调整分辨率或帧率'):
            ffmpeg_transcode.build_general_transcode_command(
                'ffmpeg', 'clip.mov', 'clip.mp4',
                container='mp4', video_mode='copy', quality='balanced',
                resolution='1080p', frame_rate='original', audio_mode='copy',
            )

    def test_general_video_transcode_prefers_gpu_and_falls_back_to_cpu(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mov'
            source.write_bytes(b'video')
            attempts = []
            logs = []

            def run_attempt(command, _duration, _on_progress, _cancel_check):
                attempts.append(command)
                if 'h264_nvenc' in command:
                    Path(command[-1]).write_bytes(b'partial')
                    return 1, 'NVENC initialization failed'
                Path(command[-1]).write_bytes(b'transcoded')
                return 0, ''

            with mock.patch.object(ffmpeg_transcode, 'get_ffmpeg_exe', return_value='ffmpeg'), \
                    mock.patch.object(ffmpeg_transcode, 'video_preview_encoder_candidates', return_value=['h264_nvenc', 'libx264']), \
                    mock.patch.object(ffmpeg_transcode, 'probe_duration', return_value=10.0), \
                    mock.patch.object(ffmpeg_transcode, '_run_general_transcode_attempt', side_effect=run_attempt):
                output = ffmpeg_transcode.transcode_video(str(source), on_log=logs.append)

            self.assertEqual(len(attempts), 2)
            self.assertIn('h264_nvenc', attempts[0])
            self.assertIn('libx264', attempts[1])
            self.assertEqual(Path(output).read_bytes(), b'transcoded')
            self.assertTrue(any('GPU 编码器 h264_nvenc 不可用' in message for message in logs))
            self.assertIn('视频编码器：libx264（CPU）', logs)

    def test_h265_transcode_falls_back_from_gpu_to_libx265(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mov'
            source.write_bytes(b'video')
            attempts = []
            logs = []

            def run_attempt(command, _duration, _on_progress, _cancel_check):
                attempts.append(command)
                if 'hevc_nvenc' in command:
                    Path(command[-1]).write_bytes(b'partial')
                    return 1, 'NVENC HEVC initialization failed'
                Path(command[-1]).write_bytes(b'transcoded-hevc')
                return 0, ''

            with mock.patch.object(ffmpeg_transcode, 'get_ffmpeg_exe', return_value='ffmpeg'), \
                    mock.patch.object(ffmpeg_transcode, 'general_transcode_encoder_candidates', return_value=['hevc_nvenc', 'libx265']), \
                    mock.patch.object(ffmpeg_transcode, 'probe_duration', return_value=10.0), \
                    mock.patch.object(ffmpeg_transcode, '_run_general_transcode_attempt', side_effect=run_attempt):
                output = ffmpeg_transcode.transcode_video(
                    str(source), video_mode='h265', on_log=logs.append,
                )

            self.assertEqual(len(attempts), 2)
            self.assertIn('hevc_nvenc', attempts[0])
            self.assertIn('libx265', attempts[1])
            self.assertEqual(Path(output).read_bytes(), b'transcoded-hevc')
            self.assertTrue(any('GPU 编码器 hevc_nvenc 不可用' in message for message in logs))
            self.assertIn('视频编码器：libx265（CPU）', logs)

    def test_video_transcode_cli_status_shows_backend_file_and_count(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / 'one.mp4'
            second = Path(temporary) / 'two.mp4'
            first.write_bytes(b'video-one')
            second.write_bytes(b'video-two')

            def transcode(path, **kwargs):
                backend = 'GPU' if Path(path).name == 'one.mp4' else 'CPU'
                kwargs['on_log'](f'正在尝试 {backend} 编码器：test-encoder')
                kwargs['on_progress'](50.0)
                return f'{path}.output.mp4'

            output = io.StringIO()
            with mock.patch.object(ffmpeg_transcode, 'transcode_video', side_effect=transcode), \
                    contextlib.redirect_stdout(output):
                exit_code = ffmpeg_transcode.run([
                    str(first), str(second), '--video-mode', 'h265',
                ])

            events = [json.loads(line) for line in output.getvalue().splitlines()]
            status_messages = [event['message'] for event in events if event['type'] in {'status', 'progress'}]
            self.assertEqual(exit_code, 0)
            self.assertIn('正在编码（GPU）：one.mp4（1/2）', status_messages)
            self.assertIn('正在编码（CPU）：two.mp4（2/2）', status_messages)

    def test_folder_video_transcode_uses_new_sibling_folder_and_keeps_structure(self):
        with tempfile.TemporaryDirectory() as temporary:
            source_folder = Path(temporary) / '素材'
            nested_folder = source_folder / '第一天'
            nested_folder.mkdir(parents=True)
            source = nested_folder / 'clip.mp4'
            source.write_bytes(b'video')
            (Path(temporary) / '素材_转码').mkdir()
            calls = []

            def transcode(path, **kwargs):
                calls.append((path, kwargs))
                return str(Path(kwargs['destination_directory']) / Path(path).name)

            output = io.StringIO()
            with mock.patch.object(ffmpeg_transcode, 'transcode_video', side_effect=transcode), \
                    contextlib.redirect_stdout(output):
                exit_code = ffmpeg_transcode.run([
                    str(source_folder), '--video-mode', 'h265',
                ])

            events = [json.loads(line) for line in output.getvalue().splitlines()]
            expected_directory = Path(temporary) / '素材_转码_2' / '第一天'
            self.assertEqual(exit_code, 0)
            self.assertEqual(Path(calls[0][1]['destination_directory']), expected_directory)
            self.assertEqual(calls[0][1]['output_mode'], 'new')
            self.assertTrue(any(
                event['type'] == 'log' and f'{source_folder} → {Path(temporary) / "素材_转码_2"}' in event['message']
                for event in events
            ))
            success = next(event for event in events if event['type'] == 'success')
            self.assertEqual(success['folderOutputs'], [{
                'sourceFolder': str(source_folder),
                'outputFolder': str(Path(temporary) / '素材_转码_2'),
            }])

            replace_output = io.StringIO()
            with contextlib.redirect_stdout(replace_output):
                replace_code = ffmpeg_transcode.run([
                    str(source_folder), '--output-mode', 'replace',
                ])
            self.assertEqual(replace_code, 1)
            self.assertIn('文件夹转码任务不能替换原视频', replace_output.getvalue())

    def test_delete_original_mode_allows_format_change_after_verified_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mov'
            source.write_bytes(b'original-video')

            def run_attempt(command, _duration, _on_progress, _cancel_check):
                Path(command[-1]).write_bytes(b'transcoded-video')
                return 0, ''

            def recycle(path):
                Path(path).unlink()

            with mock.patch.object(ffmpeg_transcode, 'get_ffmpeg_exe', return_value='ffmpeg'), \
                    mock.patch.object(ffmpeg_transcode, 'general_transcode_encoder_candidates', return_value=['libx264']), \
                    mock.patch.object(ffmpeg_transcode, 'probe_duration', return_value=10.0), \
                    mock.patch.object(ffmpeg_transcode, '_run_general_transcode_attempt', side_effect=run_attempt), \
                    mock.patch.object(ffmpeg_transcode, 'send2trash', side_effect=recycle) as send_to_trash:
                output = ffmpeg_transcode.transcode_video(
                    str(source), container='mp4', output_mode='delete-original',
                )

            self.assertEqual(Path(output), Path(temporary) / 'clip.mp4')
            self.assertEqual(Path(output).read_bytes(), b'transcoded-video')
            self.assertFalse(source.exists())
            send_to_trash.assert_called_once_with(str(source))

    def test_delete_original_mode_can_keep_the_same_name_and_format(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mp4'
            source.write_bytes(b'original-video')

            def run_attempt(command, _duration, _on_progress, _cancel_check):
                Path(command[-1]).write_bytes(b'transcoded-video')
                return 0, ''

            with mock.patch.object(ffmpeg_transcode, 'get_ffmpeg_exe', return_value='ffmpeg'), \
                    mock.patch.object(ffmpeg_transcode, 'general_transcode_encoder_candidates', return_value=['libx264']), \
                    mock.patch.object(ffmpeg_transcode, 'probe_duration', return_value=10.0), \
                    mock.patch.object(ffmpeg_transcode, '_run_general_transcode_attempt', side_effect=run_attempt), \
                    mock.patch.object(ffmpeg_transcode, 'send2trash', side_effect=lambda path: Path(path).unlink()):
                output = ffmpeg_transcode.transcode_video(
                    str(source), container='mp4', output_mode='delete-original',
                )

            self.assertEqual(Path(output), source)
            self.assertEqual(source.read_bytes(), b'transcoded-video')

    def test_delete_original_mode_keeps_source_when_cancelled_before_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mov'
            source.write_bytes(b'original-video')
            cancellation_checks = []

            def run_attempt(command, _duration, _on_progress, _cancel_check):
                Path(command[-1]).write_bytes(b'transcoded-video')
                return 0, ''

            def cancel_before_commit():
                cancellation_checks.append(True)
                if len(cancellation_checks) >= 2:
                    raise RuntimeError('cancelled before commit')

            with mock.patch.object(ffmpeg_transcode, 'get_ffmpeg_exe', return_value='ffmpeg'), \
                    mock.patch.object(ffmpeg_transcode, 'general_transcode_encoder_candidates', return_value=['libx264']), \
                    mock.patch.object(ffmpeg_transcode, 'probe_duration', return_value=10.0), \
                    mock.patch.object(ffmpeg_transcode, '_run_general_transcode_attempt', side_effect=run_attempt), \
                    mock.patch.object(ffmpeg_transcode, 'send2trash') as send_to_trash:
                with self.assertRaisesRegex(RuntimeError, 'cancelled before commit'):
                    ffmpeg_transcode.transcode_video(
                        str(source), container='mp4', output_mode='delete-original',
                        cancel_check=cancel_before_commit,
                    )

            self.assertEqual(source.read_bytes(), b'original-video')
            self.assertFalse((Path(temporary) / 'clip.mp4').exists())
            send_to_trash.assert_not_called()

    def test_delete_original_folder_batch_keeps_failed_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            source_folder = Path(temporary) / '素材'
            source_folder.mkdir()
            first = source_folder / 'one.mov'
            second = source_folder / 'two.mov'
            first.write_bytes(b'video-one')
            second.write_bytes(b'video-two')

            def transcode(path, **kwargs):
                if Path(path).name == 'two.mov':
                    raise RuntimeError('simulated transcode failure')
                destination = Path(kwargs['destination_directory']) / 'one.mp4'
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b'transcoded-one')
                Path(path).unlink()
                return str(destination)

            output = io.StringIO()
            with mock.patch.object(ffmpeg_transcode, 'transcode_video', side_effect=transcode), \
                    contextlib.redirect_stdout(output):
                exit_code = ffmpeg_transcode.run([
                    str(source_folder), '--container', 'mp4', '--output-mode', 'delete-original',
                ])

            events = [json.loads(line) for line in output.getvalue().splitlines()]
            success = next(event for event in events if event['type'] == 'success')
            self.assertEqual(exit_code, 0)
            self.assertFalse(first.exists())
            self.assertTrue(second.exists())
            self.assertEqual(success['failedCount'], 1)
            self.assertIn('失败 1 个（原视频已保留）', success['message'])
            self.assertTrue(any(event['type'] == 'warning' and 'two.mov 转码失败，原视频已保留' in event['message'] for event in events))
            self.assertEqual(len(success['folderOutputs']), 1)

    def test_transcode_commit_retries_windows_sharing_violations(self):
        calls = []

        def operation():
            calls.append(True)
            if len(calls) < 3:
                error = OSError('sharing violation')
                error.winerror = 32
                raise error
            return 'committed'

        with mock.patch.object(ffmpeg_transcode.time, 'sleep') as sleep:
            result = ffmpeg_transcode._retry_windows_sharing_violation(operation)

        self.assertEqual(result, 'committed')
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleep.call_count, 2)

    def test_lossless_split_service_commits_segments_transactionally(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'clip.mov'
            source.write_bytes(b'0123456789')

            def create_segments(command, _cancel_check):
                pattern = command[-1]
                Path(pattern.replace('%03d', '000')).write_bytes(b'first')
                Path(pattern.replace('%03d', '001')).write_bytes(b'second')
                return 0, ''

            with mock.patch.object(ffmpeg_transcode, 'probe_duration', return_value=10.0), \
                    mock.patch.object(ffmpeg_transcode, '_run_cancellable_process', side_effect=create_segments):
                outputs = ffmpeg_transcode.split_video_by_size(
                    str(source),
                    split_threshold_bytes=1,
                    target_segment_bytes=5,
                    maximum_segment_bytes=10,
                    keep_original=True,
                )

            self.assertEqual([Path(path).name for path in outputs], ['clip_part000.mov', 'clip_part001.mov'])
            self.assertTrue(source.is_file())
            self.assertFalse(any(Path(temporary).glob('.photoflow-split-*')))

    def test_lossless_split_retries_with_more_headroom_when_a_segment_is_oversized(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'large.mp4'
            source.write_bytes(b'0123456789')
            segment_times = []

            def create_segments(command, _cancel_check):
                pattern = command[-1]
                segment_times.append(float(command[command.index('-segment_time') + 1]))
                if len(segment_times) == 1:
                    Path(pattern.replace('%03d', '000')).write_bytes(b'12345678901')
                    Path(pattern.replace('%03d', '001')).write_bytes(b'part')
                else:
                    Path(pattern.replace('%03d', '000')).write_bytes(b'first')
                    Path(pattern.replace('%03d', '001')).write_bytes(b'second')
                    Path(pattern.replace('%03d', '002')).write_bytes(b'third')
                return 0, ''

            with mock.patch.object(ffmpeg_transcode, 'probe_duration', return_value=10.0), \
                    mock.patch.object(ffmpeg_transcode, '_run_cancellable_process', side_effect=create_segments):
                outputs = ffmpeg_transcode.split_video_by_size(
                    str(source),
                    split_threshold_bytes=1,
                    target_segment_bytes=5,
                    maximum_segment_bytes=10,
                    keep_original=True,
                )

            self.assertEqual(len(segment_times), 2)
            self.assertLess(segment_times[1], segment_times[0])
            self.assertEqual([Path(path).name for path in outputs], ['large_part000.mp4', 'large_part001.mp4', 'large_part002.mp4'])
            self.assertTrue(source.is_file())

    def test_sd_broll_uses_project_broll_root_and_split_setting(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            source = dcim / 'clip.mp4'
            source.write_bytes(b'video')

            def fake_split(destination, keep_original=False):
                destination = Path(destination)
                segments = [destination.with_name(f'{destination.stem}_part00{index}{destination.suffix}') for index in (1, 2)]
                for segment in segments:
                    segment.write_bytes(b'part')
                if not keep_original:
                    destination.unlink()
                return [str(segment) for segment in segments]

            with mock.patch.object(classify, 'FOUR_GB', 1), mock.patch.object(classify, 'split_broll_video', side_effect=fake_split) as splitter:
                classify.stage_import_broll(str(root / 'card'), str(project), delete_source=False, split_large_files=True)

            broll = project / '花絮'
            self.assertTrue((broll / 'clip_part001.mp4').is_file())
            self.assertTrue((broll / 'clip_part002.mp4').is_file())
            self.assertFalse(any(path.is_dir() for path in broll.iterdir()))
            self.assertTrue(source.is_file())
            splitter.assert_called_once()

    def test_sd_broll_transcodes_entire_imported_folder_into_sibling_folder(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            for name in ('one.mov', 'two.mp4'):
                (dcim / name).write_bytes(name.encode())
            (dcim / 'photo.jpg').write_bytes(b'image')
            calls = []

            def fake_transcode(input_path, **kwargs):
                calls.append(Path(input_path).name)
                destination = Path(kwargs['destination_directory']) / f'{Path(input_path).stem}.mp4'
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(FAKE_MP4_BYTES)
                return str(destination)

            output = io.StringIO()
            with contextlib.redirect_stdout(output), mock.patch.object(
                classify, 'transcode_video', side_effect=fake_transcode,
            ):
                classify.stage_import_broll(
                    str(root / 'card'), str(project),
                    transcode_import_videos=True,
                )

            self.assertEqual(sorted(calls), ['one.mov', 'two.mp4'])
            self.assertEqual(
                sorted(path.name for path in (project / '花絮_转码').glob('*.mp4')),
                ['one.mp4', 'two.mp4'],
            )
            self.assertTrue((project / '花絮' / 'one.mov').is_file())
            self.assertTrue((project / '花絮' / 'two.mp4').is_file())
            events = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith('{')]
            success = next(event for event in events if event.get('type') == 'success')
            self.assertEqual(success['data']['transcodeCount'], 2)
            self.assertIn(str(project / '花絮_转码' / 'one.mp4'), success['data']['importedPaths'])

    def test_split_broll_name_avoids_existing_segment_series(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'clip_part001.mp4').write_bytes(b'old')
            destination = classify.unique_broll_destination(str(directory), 'clip.mp4', will_split=True)
            self.assertEqual(Path(destination).name, 'clip (1).mp4')

    def test_broll_promotes_staged_file_with_same_volume_atomic_move(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = root / '_PhotoFlow_Safety_Temp' / 'atomic'
            project = root / 'project'
            original = root / 'card' / 'DCIM' / 'clip.mp4'
            staged = staging / 'clip.mp4'
            original.parent.mkdir(parents=True)
            staging.mkdir(parents=True)
            project.mkdir()
            original.write_bytes(b'original')
            staged.write_bytes(b'local-copy')
            staged_import = {
                'baseSource': str(root / 'card'),
                'originalFiles': [str(original)],
                'stagedFiles': [str(staged)],
                'stagingDir': str(staging),
                'totalBytes': staged.stat().st_size,
            }

            with mock.patch.object(classify, 'stage_media_to_safety_temp', return_value=staged_import), \
                    mock.patch.object(classify, 'safe_chunk_copy', wraps=classify.safe_chunk_copy) as copy_file:
                classify.stage_import_broll(str(root / 'card'), str(project))

            copy_file.assert_not_called()
            self.assertFalse(staged.exists())
            self.assertEqual((project / '花絮' / 'clip.mp4').read_bytes(), b'local-copy')
            self.assertTrue(original.exists())

    def test_broll_large_split_uses_atomic_move_without_second_full_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = root / '_PhotoFlow_Safety_Temp' / 'atomic-split'
            project = root / 'project'
            original = root / 'card' / 'DCIM' / 'clip.mp4'
            staged = staging / 'clip.mp4'
            original.parent.mkdir(parents=True)
            staging.mkdir(parents=True)
            project.mkdir()
            original.write_bytes(b'original')
            staged.write_bytes(b'local-copy')
            staged_import = {
                'baseSource': str(root / 'card'),
                'originalFiles': [str(original)],
                'stagedFiles': [str(staged)],
                'stagingDir': str(staging),
                'totalBytes': staged.stat().st_size,
            }

            def fake_split(destination, keep_original=False):
                self.assertTrue(keep_original)
                destination = Path(destination)
                segments = [destination.with_name(f'{destination.stem}_part00{index}{destination.suffix}') for index in (1, 2)]
                for segment in segments:
                    segment.write_bytes(b'part')
                return [str(segment) for segment in segments]

            with mock.patch.object(classify, 'FOUR_GB', 1), \
                    mock.patch.object(classify, 'stage_media_to_safety_temp', return_value=staged_import), \
                    mock.patch.object(classify, 'split_broll_video', side_effect=fake_split), \
                    mock.patch.object(classify, 'safe_chunk_copy', wraps=classify.safe_chunk_copy) as copy_file:
                classify.stage_import_broll(str(root / 'card'), str(project), split_large_files=True)

            copy_file.assert_not_called()
            self.assertFalse(staged.exists())
            self.assertFalse((project / '花絮' / 'clip.mp4').exists())
            self.assertTrue((project / '花絮' / 'clip_part001.mp4').is_file())
            self.assertTrue((project / '花絮' / 'clip_part002.mp4').is_file())

    def test_broll_falls_back_to_copy_when_atomic_move_is_unavailable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'staged.mp4'
            destination_folder = root / '花絮'
            destination = destination_folder / source.name
            source.write_bytes(b'local-copy')
            destination_folder.mkdir()

            real_move = classify._move_file_no_replace
            move_attempt = 0

            def fail_first_move(source_path, destination_path):
                nonlocal move_attempt
                move_attempt += 1
                if move_attempt == 1:
                    raise OSError(errno.EXDEV, 'cross-device link')
                return real_move(source_path, destination_path)

            with mock.patch.object(classify, '_move_file_no_replace', side_effect=fail_first_move), \
                    mock.patch.object(classify, 'safe_chunk_copy', wraps=classify.safe_chunk_copy) as copy_file:
                moved = classify.promote_staged_file(str(source), str(destination))

            self.assertFalse(moved)
            copy_file.assert_called_once()
            self.assertTrue(source.exists())
            self.assertEqual(destination.read_bytes(), b'local-copy')

    def test_cross_device_promotion_copy_is_fsynced_without_rehashing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'staged.bin'
            destination = root / 'target' / 'media.bin'
            source.write_bytes(b'durable-cross-device-copy')
            destination.parent.mkdir()
            real_stat = classify.os.stat

            def cross_device_stat(path, *args, **kwargs):
                actual = real_stat(path, *args, **kwargs)
                overridden_device = 101 if os.path.abspath(path) == os.path.abspath(source) else 202 if os.path.abspath(path) == os.path.abspath(destination.parent) else actual.st_dev
                values = {name: getattr(actual, name) for name in dir(actual) if name.startswith('st_')}
                values['st_dev'] = overridden_device
                return SimpleNamespace(**values)

            with mock.patch.object(classify.os, 'stat', side_effect=cross_device_stat), \
                    mock.patch.object(classify.os, 'fsync') as fsync, \
                    mock.patch.object(classify.hashlib, 'sha256', wraps=hashlib.sha256) as sha256:
                moved = classify.promote_staged_file(str(source), str(destination), allow_atomic_move=True)

            self.assertFalse(moved)
            self.assertEqual(destination.read_bytes(), b'durable-cross-device-copy')
            self.assertGreaterEqual(fsync.call_count, 1)
            # Promotion may sample source/target for collision safety, but it
            # must not compute one SHA per copied chunk again.
            self.assertLess(sha256.call_count, 6)

    def test_cancelled_broll_restores_files_atomically_moved_from_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = root / '_PhotoFlow_Safety_Temp' / 'cancel-rollback'
            project = root / 'project'
            originals = [root / 'card' / 'DCIM' / f'{index}.jpg' for index in range(2)]
            staged_files = [staging / f'{index}.jpg' for index in range(2)]
            originals[0].parent.mkdir(parents=True)
            staging.mkdir(parents=True)
            project.mkdir()
            for original, staged in zip(originals, staged_files):
                original.write_bytes(b'original')
                staged.write_bytes(b'local-copy')
            staged_import = {
                'baseSource': str(root / 'card'),
                'originalFiles': [str(path) for path in originals],
                'stagedFiles': [str(path) for path in staged_files],
                'stagingDir': str(staging),
                'totalBytes': sum(path.stat().st_size for path in staged_files),
            }

            with mock.patch.object(classify, 'stage_media_to_safety_temp', return_value=staged_import), \
                    mock.patch.object(classify, 'ensure_not_cancelled', side_effect=[None, classify.ImportCancelled('cancelled')]), \
                    mock.patch.object(classify, 'emit') as emit:
                classify.stage_import_broll(str(root / 'card'), str(project))

            self.assertTrue(all(path.exists() for path in staged_files))
            self.assertFalse(any((project / '花絮').glob('*.jpg')) if (project / '花絮').exists() else False)
            self.assertTrue(any(call.args and call.args[0] == 'cancelled' for call in emit.call_args_list))

    def test_cancelling_source_cleanup_stops_further_deletion_and_keeps_targets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            sources = [dcim / 'one.jpg', dcim / 'two.jpg']
            for source in sources:
                source.write_bytes(b'image')
            cancel_file = root / 'cancel.flag'
            classify.CANCEL_FILE = str(cancel_file)
            real_remove = os.remove
            source_paths = {str(source) for source in sources}
            removed_sources = []

            def cancel_after_first_source(path):
                real_remove(path)
                if str(path) in source_paths:
                    removed_sources.append(str(path))
                    if len(removed_sources) == 1:
                        cancel_file.write_text('cancel', encoding='utf-8')

            with mock.patch.object(classify.os, 'remove', side_effect=cancel_after_first_source), mock.patch.object(classify, 'emit') as emit:
                classify.stage_import_broll(str(root / 'card'), str(project), delete_source=True)

            self.assertEqual(sum(source.exists() for source in sources), 1)
            self.assertEqual(len(list((project / '花絮').glob('*.jpg'))), 2)
            self.assertTrue(any(call.args and call.args[0] == 'cancelled' for call in emit.call_args_list))

    def test_cancelling_plan_emits_cancelled_without_raising(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            dcim.mkdir(parents=True)
            (dcim / 'photo.jpg').write_bytes(b'image')
            cancel_file = root / 'cancel.flag'
            cancel_file.write_text('cancel', encoding='utf-8')

            with mock.patch.object(classify, 'emit') as emit:
                classify.run([
                    '--stage', 'plan',
                    '--sd_path', str(root / 'card'),
                    '--dest_path', str(root),
                    '--import_session', 'cancel-plan',
                    '--cancel_file', str(cancel_file),
                ])

            self.assertTrue(any(call.args and call.args[0] == 'cancelled' for call in emit.call_args_list))

    def test_plan_reports_progress_while_reading_capture_times(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            dcim.mkdir(parents=True)
            files = [dcim / 'one.jpg', dcim / 'two.jpg']
            for source in files:
                source.write_bytes(b'image')

            with mock.patch.object(classify, 'get_file_time', return_value=datetime.datetime(2026, 8, 1, 12).timestamp()) as capture_time, \
                    mock.patch.object(classify, 'log_progress') as progress, \
                    mock.patch.object(classify, 'ask_user'):
                classify.stage_plan_import(str(root / 'card'), str(root), '[]', import_session='progress-plan')

            messages = [call.args[0] for call in progress.call_args_list]
            percentages = [call.args[1] for call in progress.call_args_list]
            self.assertEqual(percentages[0], 0)
            self.assertTrue(any('1/2' in message for message in messages))
            self.assertTrue(any('2/2' in message for message in messages))
            self.assertEqual(percentages[-1], 95)
            capture_paths = [call.args[0] for call in capture_time.call_args_list]
            self.assertTrue(capture_paths)
            self.assertTrue(all('_PhotoFlow_Safety_Temp' in path for path in capture_paths))

    def test_capture_groups_adapt_to_a_clear_gap_under_two_hours(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            start = datetime.datetime(2026, 8, 1, 9)
            offsets = [0, 10, 50, 50 * 60, 50 * 60 + 15, 50 * 60 + 70]
            files = []
            for index, offset in enumerate(offsets):
                source = root / f'{index}.jpg'
                source.write_bytes(b'image')
                timestamp = (start + datetime.timedelta(seconds=offset)).timestamp()
                os.utime(source, (timestamp, timestamp))
                files.append(str(source))

            groups = classify.build_capture_groups(files)

            self.assertEqual([group['count'] for group in groups], [3, 3])

    def test_capture_groups_do_not_split_an_unclear_or_tiny_tail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            start = datetime.datetime(2026, 8, 1, 9)
            offsets = [0, 10 * 60, 20 * 60, 50 * 60, 60 * 60, 70 * 60]
            files = []
            for index, offset in enumerate(offsets):
                source = root / f'{index}.jpg'
                source.write_bytes(b'image')
                timestamp = (start + datetime.timedelta(seconds=offset)).timestamp()
                os.utime(source, (timestamp, timestamp))
                files.append(str(source))

            self.assertEqual([group['count'] for group in classify.build_capture_groups(files)], [6])

            tail = root / 'tail.jpg'
            tail.write_bytes(b'image')
            tail_time = (start + datetime.timedelta(hours=2)).timestamp()
            os.utime(tail, (tail_time, tail_time))
            self.assertEqual([group['count'] for group in classify.build_capture_groups([*files, str(tail)])], [7])

    def test_hard_four_hour_gap_splits_even_a_small_segment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            start = datetime.datetime(2026, 8, 1, 9)
            files = []
            for index, offset in enumerate((0, 10, 5 * 3600)):
                source = root / f'{index}.jpg'
                source.write_bytes(b'image')
                timestamp = (start + datetime.timedelta(seconds=offset)).timestamp()
                os.utime(source, (timestamp, timestamp))
                files.append(str(source))

            self.assertEqual([group['count'] for group in classify.build_capture_groups(files)], [2, 1])

    def test_adaptive_groups_can_route_to_the_same_project(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            card = root / 'card'
            dcim = card / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            start = datetime.datetime(2026, 8, 1, 9)
            offsets = [0, 10, 50, 50 * 60, 50 * 60 + 15, 50 * 60 + 70]
            for index, offset in enumerate(offsets):
                source = dcim / f'{index}.jpg'
                source.write_bytes(b'image')
                timestamp = (start + datetime.timedelta(seconds=offset)).timestamp()
                os.utime(source, (timestamp, timestamp))

            classify.stage_import_and_organize(
                str(card),
                str(root),
                project_routes={
                    '2026-08-01:1': str(project),
                    '2026-08-01:2': str(project),
                },
            )

            self.assertEqual(len(list((project / 'jpg').glob('*.jpg'))), len(offsets))

    def test_plan_rejects_files_that_disappear_during_scan(self):
        with tempfile.TemporaryDirectory() as temporary:
            missing_file = os.path.join('G:\\', 'DCIM', 'missing.jpg')
            with mock.patch.object(classify, 'scan_import_media', return_value=('G:\\', [missing_file])), \
                    mock.patch.object(classify, 'log_progress'), \
                    mock.patch.object(classify, 'log_error') as error, \
                    mock.patch.object(classify, 'ask_user') as ask_user:
                classify.stage_plan_import('G:\\', temporary, '[]', import_session='missing-plan')

            self.assertTrue(error.called)
            self.assertIn('源设备可能已断开', error.call_args.args[0])
            ask_user.assert_not_called()

    def test_empty_card_is_skipped_without_blocking_the_batch(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(classify, 'scan_import_media', return_value=('G:\\', [])), \
                    mock.patch.object(classify, 'log_success') as success, \
                    mock.patch.object(classify, 'log_error') as error:
                classify.stage_plan_import('G:\\', temporary, '[]', import_session='empty-card')

            success.assert_called_once()
            self.assertTrue(success.call_args.args[1]['skipped'])
            self.assertEqual(success.call_args.args[1]['skipReason'], 'no-media')
            error.assert_not_called()

    def test_work_import_reuses_staged_copy_after_source_disconnects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / '26-8-1 project'
            dcim.mkdir(parents=True)
            project.mkdir()
            source = dcim / 'photo.jpg'
            source.write_bytes(b'image-data')
            captured_at = datetime.datetime(2026, 8, 1, 12, 30).timestamp()
            os.utime(source, (captured_at, captured_at))
            session = 'staged-disconnect'
            projects = [{
                'id': 'project-stable-id',
                'name': project.name,
                'path': str(project),
                'projectDate': {'year': 2026, 'month': 8, 'day': 1, 'precision': 'day'},
            }]

            with mock.patch.object(classify, 'ask_user') as ask_user:
                classify.stage_plan_import(str(root / 'card'), str(root), json.dumps(projects), import_session=session)
            routes = ask_user.call_args.args[1]['automaticRoutes']
            self.assertTrue(routes)
            self.assertEqual(set(routes.values()), {'project-stable-id'})
            # The renderer resolves stable IDs to the latest catalog paths
            # immediately before committing the already-staged files.
            routes = {group_id: str(project) for group_id in routes}
            staged = classify.load_staged_import(str(root), session)
            self.assertTrue(staged)
            self.assertEqual(len(staged['timedFiles']), 1)

            source.unlink()
            output = io.StringIO()
            with contextlib.redirect_stdout(output), mock.patch.object(
                classify,
                'get_file_time',
                side_effect=AssertionError('the confirmed import must reuse cached capture times'),
            ):
                classify.stage_import_and_organize(
                    str(root / 'card'),
                    str(root),
                    project_routes=routes,
                    delete_source=True,
                    import_session=session,
                )

            events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip().startswith('{')]
            success = next(event for event in events if event.get('type') == 'success')
            self.assertTrue((project / 'jpg' / 'photo.jpg').is_file())
            self.assertFalse(success['data']['sourceFilesDeleted'])
            self.assertIsNotNone(classify.load_staged_import(str(root), session))
            receipt = classify.load_import_graph_receipt(classify.get_import_staging_dir(str(root), session))
            self.assertEqual(receipt['importSessionId'], session)
            self.assertEqual(receipt['manifests'][0]['schemaVersion'], 2)

    def test_same_drive_changed_source_never_reuses_old_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            workspace = root / 'workspace'
            dcim.mkdir(parents=True)
            workspace.mkdir()
            source = dcim / 'same.jpg'
            source.write_bytes(b'OLD!')
            original_mtime = source.stat().st_mtime_ns
            classify.stage_media_to_safety_temp(str(root / 'card'), str(workspace), import_session='same-drive')

            source.write_bytes(b'NEW!')
            os.utime(source, ns=(original_mtime, original_mtime))
            with self.assertRaises(classify.SourceIdentityMismatch):
                classify.stage_media_to_safety_temp(str(root / 'card'), str(workspace), import_session='same-drive')

    def test_direct_project_skips_capture_time_reading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            (dcim / 'photo.jpg').write_bytes(b'image')

            output = io.StringIO()
            with contextlib.redirect_stdout(output), mock.patch.object(classify, 'staged_files_with_capture_times', side_effect=AssertionError('fixed projects do not need capture times')):
                classify.stage_import_and_organize(str(root / 'card'), str(project), direct_project=True)

            self.assertTrue((project / 'jpg' / 'photo.jpg').is_file())
            events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip().startswith('{')]
            success = next(event for event in events if event.get('type') == 'success')
            self.assertTrue(success['data']['importSessionId'])
            self.assertEqual(success['data']['importManifests'][0]['importSessionId'], success['data']['importSessionId'])

    def test_work_import_recovers_pending_commit_without_duplicate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            for name in ('one.jpg', 'two.jpg'):
                (dcim / name).write_bytes(name.encode())
            session = 'commit-recovery'
            staged = classify.stage_media_to_safety_temp(str(root / 'card'), str(project), import_session=session)
            first_entry = staged['entries'][0]
            jpg_dir = project / 'jpg'
            jpg_dir.mkdir()
            pending = jpg_dir / 'one.jpg'
            classify.update_staged_entry(staged, first_entry['staged'], {'pendingDestination': str(pending)})
            os.replace(first_entry['staged'], pending)

            classify.stage_import_and_organize(str(root / 'card'), str(project), direct_project=True, import_session=session)

            self.assertEqual(sorted(path.name for path in jpg_dir.glob('*.jpg')), ['one.jpg', 'two.jpg'])
            self.assertFalse(any(jpg_dir.glob('* (1).jpg')))

    def test_work_import_checkpoints_manifest_a_constant_number_of_times(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            for index in range(120):
                (dcim / f'photo-{index:03d}.jpg').write_bytes(f'image-{index}'.encode())
            session = 'bounded-checkpoints'
            classify.stage_media_to_safety_temp(str(root / 'card'), str(project), import_session=session)

            output = io.StringIO()
            real_write = classify._write_staging_manifest
            with contextlib.redirect_stdout(output), mock.patch.object(classify, '_write_staging_manifest', wraps=real_write) as manifest_writes:
                classify.stage_import_and_organize(
                    str(root / 'card'),
                    str(project),
                    direct_project=True,
                    import_session=session,
                )

            self.assertEqual(manifest_writes.call_count, 2)
            events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip().startswith('{')]
            organizing = [event for event in events if event.get('data', {}).get('phase') == 'organizing']
            self.assertTrue(organizing)
            self.assertEqual(organizing[-1]['data']['filesProcessed'], 120)
            self.assertEqual(len(list((project / 'jpg').glob('*.jpg'))), 120)

    def test_work_import_recovers_from_crash_after_batch_plan_without_duplicates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            for name in ('one.jpg', 'two.jpg', 'three.jpg'):
                (dcim / name).write_bytes(name.encode())
            session = 'batch-plan-crash'
            classify.stage_media_to_safety_temp(str(root / 'card'), str(project), import_session=session)

            real_promote = classify.promote_staged_file
            promote_count = 0

            def fail_on_second_promote(source, destination, on_progress=None, allow_atomic_move=True, temporary_path=None):
                nonlocal promote_count
                promote_count += 1
                if promote_count == 2:
                    raise OSError('simulated crash after the first promotion')
                return real_promote(source, destination, on_progress, allow_atomic_move, temporary_path)

            with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(classify, 'promote_staged_file', side_effect=fail_on_second_promote):
                classify.stage_import_and_organize(
                    str(root / 'card'),
                    str(project),
                    direct_project=True,
                    import_session=session,
                )

            with open(classify._staging_manifest_path(classify.get_import_staging_dir(str(project), session)), 'r', encoding='utf-8') as manifest_file:
                manifest = json.load(manifest_file)
            self.assertTrue(all(entry.get('pendingDestination') for entry in manifest['files']))

            with contextlib.redirect_stdout(io.StringIO()):
                classify.stage_import_and_organize(
                    str(root / 'card'),
                    str(project),
                    direct_project=True,
                    import_session=session,
                )

            self.assertEqual(sorted(path.name for path in (project / 'jpg').glob('*.jpg')), ['one.jpg', 'three.jpg', 'two.jpg'])
            self.assertFalse(any((project / 'jpg').glob('* (1).jpg')))

    def test_work_import_reserves_duplicate_source_names_before_moving(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first_source = root / 'first'
            second_source = root / 'second'
            project = root / 'project'
            first_source.mkdir()
            second_source.mkdir()
            project.mkdir()
            (first_source / 'photo.jpg').write_bytes(b'first')
            (second_source / 'photo.jpg').write_bytes(b'second')

            with contextlib.redirect_stdout(io.StringIO()):
                classify.stage_import_and_organize(
                    str(first_source),
                    str(project),
                    direct_project=True,
                    direct_source=True,
                    source_paths=[str(first_source), str(second_source)],
                    import_session='duplicate-source-names',
                )

            imported = sorted((project / 'jpg').glob('*.jpg'))
            self.assertEqual([path.name for path in imported], ['photo (1).jpg', 'photo.jpg'])
            self.assertEqual({path.read_bytes() for path in imported}, {b'first', b'second'})

    def test_work_import_never_accepts_same_size_foreign_pending_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            source = dcim / 'one.jpg'
            source.write_bytes(b'AAAA')
            session = 'same-size-foreign-target'
            classify.stage_media_to_safety_temp(str(root / 'card'), str(project), import_session=session)

            with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(classify, 'promote_staged_file', side_effect=OSError('stop after plan')):
                classify.stage_import_and_organize(str(root / 'card'), str(project), direct_project=True, import_session=session)
            manifest_path = classify._staging_manifest_path(classify.get_import_staging_dir(str(project), session))
            with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
                pending = Path(json.load(manifest_file)['files'][0]['pendingDestination'])
            pending.write_bytes(b'BBBB')

            with contextlib.redirect_stdout(io.StringIO()):
                classify.stage_import_and_organize(
                    str(root / 'card'),
                    str(project),
                    direct_project=True,
                    import_session=session,
                    delete_source=True,
                )

            self.assertEqual(pending.read_bytes(), b'BBBB')
            self.assertEqual((project / 'jpg' / 'one (1).jpg').read_bytes(), b'AAAA')
            self.assertFalse(source.exists())

    def test_work_import_never_accepts_same_size_foreign_committed_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            source = dcim / 'one.jpg'
            source.write_bytes(b'AAAA')
            session = 'same-size-foreign-commit'
            classify.stage_media_to_safety_temp(str(root / 'card'), str(project), import_session=session)

            with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(classify, 'promote_staged_file', side_effect=OSError('stop after plan')):
                classify.stage_import_and_organize(str(root / 'card'), str(project), direct_project=True, import_session=session)
            manifest_path = classify._staging_manifest_path(classify.get_import_staging_dir(str(project), session))
            with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
                manifest = json.load(manifest_file)
            committed = Path(manifest['files'][0].pop('pendingDestination'))
            manifest['files'][0]['committedDestination'] = str(committed)
            committed.write_bytes(b'BBBB')
            with open(manifest_path, 'w', encoding='utf-8') as manifest_file:
                json.dump(manifest, manifest_file)

            with contextlib.redirect_stdout(io.StringIO()):
                classify.stage_import_and_organize(
                    str(root / 'card'),
                    str(project),
                    direct_project=True,
                    import_session=session,
                    delete_source=True,
                )

            self.assertEqual(committed.read_bytes(), b'BBBB')
            self.assertEqual((project / 'jpg' / 'one (1).jpg').read_bytes(), b'AAAA')
            self.assertFalse(source.exists())

    def test_work_import_recovers_partial_part_file_without_exposing_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            (dcim / 'one.jpg').write_bytes(b'ORIGINAL')
            session = 'partial-part-file'
            classify.stage_media_to_safety_temp(str(root / 'card'), str(project), import_session=session)

            def leave_partial_part(source, destination, on_progress=None, allow_atomic_move=True, temporary_path=None):
                Path(temporary_path).write_bytes(b'PART')
                raise SystemExit('simulated hard stop')

            with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()), \
                    mock.patch.object(classify, 'promote_staged_file', side_effect=leave_partial_part):
                classify.stage_import_and_organize(
                    str(root / 'card'),
                    str(project),
                    direct_project=True,
                    import_session=session,
                )

            with contextlib.redirect_stdout(io.StringIO()):
                classify.stage_import_and_organize(
                    str(root / 'card'),
                    str(project),
                    direct_project=True,
                    import_session=session,
                )

            imported = list((project / 'jpg').glob('*.jpg'))
            self.assertEqual([path.name for path in imported], ['one.jpg'])
            self.assertEqual(imported[0].read_bytes(), b'ORIGINAL')
            self.assertFalse(any((project / 'jpg').glob('*.photoflow-part-*')))

    def test_work_import_recovers_when_receipt_write_crashes_without_copying_again(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            source = dcim / 'one.jpg'
            source.write_bytes(b'original-media')
            session = 'receipt-crash'

            with mock.patch.object(classify, 'write_import_graph_receipt', side_effect=OSError('simulated receipt crash')):
                classify.stage_import_and_organize(str(root / 'card'), str(project), direct_project=True, import_session=session)
            imported = project / 'jpg' / 'one.jpg'
            self.assertEqual(imported.read_bytes(), b'original-media')
            self.assertIsNone(classify.load_import_graph_receipt(classify.get_import_staging_dir(str(project), session)))

            with mock.patch.object(classify, 'safe_chunk_copy', side_effect=AssertionError('retry must reuse committed media')):
                classify.stage_import_and_organize(str(root / 'card'), str(project), direct_project=True, import_session=session)
            self.assertEqual([path.name for path in (project / 'jpg').glob('*.jpg')], ['one.jpg'])
            receipt = classify.load_import_graph_receipt(classify.get_import_staging_dir(str(project), session))
            self.assertEqual(receipt['manifests'][0]['importSessionId'], session)

    def test_empty_session_never_produces_an_uncommittable_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'import_session_required'):
                classify.build_import_graph_manifest(str(root), str(root), 'project', '', [], [], [])

    def test_work_import_transcode_keeps_mov_and_registers_transcode_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            project = root / 'project'
            dcim.mkdir(parents=True)
            project.mkdir()
            (dcim / 'clip.mov').write_bytes(b'original-video')

            def fake_transcode(input_path, **kwargs):
                destination = Path(kwargs['destination_directory']) / 'clip.mp4'
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(FAKE_MP4_BYTES)
                self.assertEqual(kwargs['output_mode'], 'new')
                return str(destination)

            output = io.StringIO()
            with contextlib.redirect_stdout(output), mock.patch.object(
                classify, 'transcode_video', side_effect=fake_transcode,
            ):
                classify.stage_import_and_organize(
                    str(root / 'card'), str(project), direct_project=True,
                    transcode_import_videos=True, import_session='import-transcode',
                )

            self.assertEqual((project / 'mov' / 'clip.mov').read_bytes(), b'original-video')
            self.assertEqual((project / 'mov_转码' / 'clip.mp4').read_bytes(), FAKE_MP4_BYTES)
            events = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith('{')]
            self.assertTrue(any('已保存到 mov_转码' in event.get('message', '') for event in events))
            success = next(event for event in events if event.get('type') == 'success')
            manifest = success['data']['importManifests'][0]
            slots = {item['relativePath']: item['importSlot'] for item in manifest['artifacts']}
            self.assertEqual(slots, {'mov': 'mov', 'mov_转码': 'video_transcode'})
            self.assertIn(str(project / 'mov_转码' / 'clip.mp4'), success['data']['importedPaths'])

            db = workspace_db.connect(str(root), str(root / 'workspace.db'))
            try:
                now = int(time.time() * 1000)
                db.execute(
                    'INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                    ('project-id', project.name, '后期中', project.name, now, now),
                )
                db.commit()
                workspace_db.media_workflow_import_commit(str(root), db, manifest)
                edge = db.execute(
                    "SELECT edge_kind FROM version_graph_edges WHERE project_id=? AND edge_kind='derived_transcode'",
                    ('project-id',),
                ).fetchone()
                self.assertIsNotNone(edge)
            finally:
                db.close()

    def test_import_transcode_uses_numbered_destination_and_tolerates_partial_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            source_dir = target / 'mov'
            output_dir = target / 'mov_转码'
            source_dir.mkdir()
            output_dir.mkdir()
            sources = [source_dir / 'clip.mov', source_dir / 'broken.mov']
            for source in sources:
                source.write_bytes(b'video')
            (output_dir / 'clip.mp4').write_bytes(b'existing')

            def fake_transcode(input_path, **kwargs):
                self.assertEqual(Path(kwargs['destination_directory']), output_dir)
                if Path(input_path).name == 'broken.mov':
                    raise classify.FFmpegTranscodeError('simulated failure')
                destination = output_dir / 'clip (1).mp4'
                destination.write_bytes(FAKE_MP4_BYTES)
                return str(destination)

            with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(
                classify, 'transcode_video', side_effect=fake_transcode,
            ):
                result = classify.transcode_imported_videos(
                    str(target), {}, source_paths=[str(path) for path in sources],
                )

            self.assertEqual(result, (1, 2, [str(output_dir / 'clip (1).mp4')]))
            self.assertTrue(all(path.is_file() for path in sources))
            self.assertEqual((output_dir / 'clip.mp4').read_bytes(), b'existing')

    def test_work_multi_video_failure_commits_output_to_exact_input_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            card = root / 'card' / 'DCIM'
            project = root / 'project'
            card.mkdir(parents=True)
            project.mkdir()
            (card / 'broken.mov').write_bytes(b'broken-original')
            (card / 'good.mov').write_bytes(b'good-original')
            session = 'work-exact-postprocess'

            def fake_transcode(input_path, **kwargs):
                if Path(input_path).name == 'broken.mov':
                    raise classify.FFmpegTranscodeError('first failed')
                output = Path(kwargs['destination_directory']) / 'good.mp4'
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(FAKE_MP4_BYTES)
                return str(output)

            with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(
                classify, 'transcode_video', side_effect=fake_transcode,
            ):
                classify.stage_import_and_organize(
                    str(root / 'card'), str(project), direct_project=True,
                    transcode_import_videos=True, import_session=session,
                )

            manifest_path = Path(classify.get_import_staging_dir(str(project), session)) / classify.STAGING_MANIFEST_NAME
            entries = {Path(entry['source']).name: entry for entry in json.loads(manifest_path.read_text(encoding='utf-8'))['files']}
            self.assertNotIn('transcode', entries['broken.mov'].get('postProcesses', {}))
            committed = entries['good.mov']['postProcesses']['transcode']
            self.assertEqual(committed['state'], 'committed')
            self.assertEqual(Path(committed['inputPath']).name, 'good.mov')
            self.assertEqual([Path(path).name for path in committed['outputPaths']], ['good.mp4'])

    def test_committed_transcode_and_raw_jpg_are_reused_on_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = root / 'staging'
            target = root / 'project'
            source = target / 'mov' / 'clip.mov'
            output = target / 'mov_转码' / 'clip.mp4'
            raw = target / 'raw' / 'photo.cr3'
            jpg = target / 'jpg' / 'photo.jpg'
            for path, data in ((source, b'video'), (output, FAKE_MP4_BYTES), (raw, b'raw')):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            jpg.parent.mkdir(parents=True, exist_ok=True)
            Image.new('RGB', (4, 4), 'white').save(jpg)
            staging.mkdir()
            entries = [
                {'source': str(source), 'staged': str(source), 'size': source.stat().st_size, 'localPath': str(source), 'postProcesses': {
                    'transcode': {'kind': 'transcode', 'state': 'committed', 'inputPath': str(source), 'outputPaths': [str(output)]},
                }},
                {'source': str(raw), 'staged': str(raw), 'size': raw.stat().st_size, 'localPath': str(raw), 'postProcesses': {
                    'raw_jpg': {'kind': 'raw_jpg', 'state': 'pending', 'inputPath': str(raw), 'pendingOutput': str(jpg)},
                }},
            ]
            staged_import = {'stagingDir': str(staging), 'entries': entries}
            (staging / classify.STAGING_MANIFEST_NAME).write_text(json.dumps({'version': 2, 'files': entries}), encoding='utf-8')

            self.assertEqual(classify.recover_post_process(staged_import, entries[0], 'transcode', str(output.parent)), [str(output)])
            self.assertEqual(classify.recover_post_process(staged_import, entries[1], 'raw_jpg', str(jpg.parent), image_output=True), [str(jpg)])
            self.assertEqual(post := classify.post_process_record(entries[1], 'raw_jpg'), {
                'kind': 'raw_jpg', 'state': 'committed', 'inputPath': str(raw), 'outputPaths': [str(jpg)],
            })
            self.assertEqual(classify.recover_post_process(staged_import, entries[1], 'raw_jpg', str(jpg.parent), image_output=True), [str(jpg)])

    def test_broll_multi_video_checkpoint_mapping_survives_first_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            card = root / 'card' / 'DCIM'
            project = root / 'project'
            card.mkdir(parents=True)
            project.mkdir()
            (card / 'broken.mov').write_bytes(b'broken')
            (card / 'good.mov').write_bytes(b'good')
            events = []
            real_checkpoint = classify.checkpoint_post_process

            def recording_checkpoint(staged_import, entry, kind, record=None):
                events.append((Path(entry['source']).name, kind, None if record is None else record.get('state')))
                return real_checkpoint(staged_import, entry, kind, record)

            def fake_transcode(input_path, **kwargs):
                if Path(input_path).name == 'broken.mov':
                    raise classify.FFmpegTranscodeError('failed first')
                output = Path(kwargs['destination_directory']) / 'good.mp4'
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(FAKE_MP4_BYTES)
                return str(output)

            with contextlib.redirect_stdout(io.StringIO()), \
                    mock.patch.object(classify, 'checkpoint_post_process', side_effect=recording_checkpoint), \
                    mock.patch.object(classify, 'transcode_video', side_effect=fake_transcode):
                classify.stage_import_broll(
                    str(root / 'card'), str(project), transcode_import_videos=True,
                    import_session='broll-exact-postprocess',
                )

            self.assertIn(('broken.mov', 'transcode', 'pending'), events)
            self.assertIn(('broken.mov', 'transcode', None), events)
            self.assertIn(('good.mov', 'transcode', 'committed'), events)
            self.assertNotIn(('broken.mov', 'transcode', 'committed'), events)

    def test_broll_resume_reuses_all_committed_split_segments(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / 'project'
            card = root / 'card'
            source = card / 'clip.mp4'
            broll = project / '花絮'
            full = broll / 'clip.mp4'
            segments = [broll / 'clip_part001.mp4', broll / 'clip_part002.mp4']
            source.parent.mkdir(parents=True)
            broll.mkdir(parents=True)
            source.write_bytes(b'full-original')
            full.write_bytes(source.read_bytes())
            for segment in segments:
                segment.write_bytes(FAKE_MP4_BYTES)
            session = 'broll-split-resume'
            staging = Path(classify.get_import_staging_dir(str(project), session))
            staging.mkdir(parents=True)
            metadata = classify._source_entry_metadata(str(source))
            entry = {
                'source': str(source), 'staged': str(staging / 'clip.mp4'), **metadata,
                'committedDestination': str(full), 'outputPaths': [str(path) for path in segments],
                'postProcesses': {'split': {
                    'kind': 'split', 'state': 'committed', 'inputPath': str(full),
                    'outputPaths': [str(path) for path in segments],
                }},
            }
            (staging / classify.STAGING_MANIFEST_NAME).write_text(json.dumps({
                'version': 2, 'baseSource': str(card),
                'sourceVolumeIdentity': classify._source_volume_identity(str(card)),
                'files': [entry],
            }), encoding='utf-8')

            output = io.StringIO()
            with contextlib.redirect_stdout(output), mock.patch.object(
                classify, 'promote_staged_file', side_effect=AssertionError('committed segments must skip promotion'),
            ):
                classify.stage_import_broll(str(card), str(project), import_session=session)

            self.assertTrue(all(path.is_file() for path in segments))
            self.assertFalse(full.exists())
            events = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith('{')]
            success = next(event for event in events if event.get('type') == 'success')
            self.assertEqual(success['data']['importedPaths'], sorted(str(path) for path in segments))

    def test_import_transcode_cancellation_propagates_and_keeps_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            source = target / 'mov' / 'clip.mov'
            source.parent.mkdir()
            source.write_bytes(b'original')

            def cancel_transcode(_input_path, **kwargs):
                raise classify.ImportCancelled('cancelled')

            with mock.patch.object(classify, 'transcode_video', side_effect=cancel_transcode):
                with self.assertRaises(classify.ImportCancelled):
                    classify.transcode_imported_videos(str(target), {}, source_paths=[str(source)])
            self.assertEqual(source.read_bytes(), b'original')
            self.assertFalse((target / 'mov_转码').exists())

    def test_video_preview_only_processes_current_import_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            source_dir = target / 'mov'
            source_dir.mkdir()
            old_video = source_dir / 'old.mov'
            new_video = source_dir / 'new.mov'
            old_video.write_bytes(b'old')
            new_video.write_bytes(b'new')
            def fake_preview(_input, output, _quality, on_log=None):
                Path(output).write_bytes(FAKE_MP4_BYTES)
                return 'libx264'

            with mock.patch.object(classify, 'transcode_video_preview', side_effect=fake_preview) as transcode:
                result = classify.generate_video_previews(str(target), source_paths=[str(new_video)])

            self.assertEqual(result, (1, 1))
            self.assertEqual(transcode.call_count, 1)
            self.assertEqual(transcode.call_args.args[0], str(new_video))
            self.assertNotEqual(transcode.call_args.args[0], str(old_video))

    def test_delete_mode_rejects_same_size_middle_corruption_and_keeps_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'card' / 'DCIM' / 'clip.mp4'
            workspace = root / 'workspace'
            source.parent.mkdir(parents=True)
            workspace.mkdir()
            payload = b'A' * 4096 + b'B' * 4096 + b'C' * 4096
            source.write_bytes(payload)
            original_copy = classify.safe_chunk_copy

            def corrupt_middle(src, dst, chunk_size=4 * 1024 * 1024, on_progress=None, collect_digest=False):
                digest = original_copy(src, dst, 4096, on_progress, collect_digest)
                damaged = bytearray(Path(dst).read_bytes())
                damaged[5000] ^= 0xFF
                Path(dst).write_bytes(damaged)
                shutil.copystat(src, dst)
                return digest

            with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(
                classify, 'safe_chunk_copy', side_effect=corrupt_middle,
            ):
                classify.stage_import_and_organize(
                    str(root / 'card'), str(workspace), direct_project=True,
                    delete_source=True, import_session='middle-corruption',
                )

            self.assertTrue(source.is_file(), 'an incompletely verified copy must never authorize source deletion')
            self.assertFalse((workspace / 'mov' / source.name).exists())

    def test_retain_source_copy_skips_chunk_sha_and_omits_copy_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.jpg'
            copied = root / 'copied.jpg'
            source.write_bytes(b'ordinary-retained-import' * 1024)
            with mock.patch.object(classify.hashlib, 'sha256', side_effect=AssertionError('chunk SHA must be disabled')):
                self.assertIsNone(classify.safe_chunk_copy(str(source), str(copied), collect_digest=False))
            self.assertEqual(copied.read_bytes(), source.read_bytes())

            workspace = root / 'workspace'
            workspace.mkdir()
            with mock.patch.object(classify, 'safe_chunk_copy', wraps=classify.safe_chunk_copy) as copy_file:
                staged = classify.stage_media_to_safety_temp(
                    str(source), str(workspace), direct_source=True,
                    source_paths=[str(source)], import_session='retain-no-digest', verify_copy=False,
                )
            self.assertIs(copy_file.call_args.kwargs['collect_digest'], False)
            manifest = json.loads((Path(staged['stagingDir']) / classify.STAGING_MANIFEST_NAME).read_text(encoding='utf-8'))
            self.assertNotIn('copyDigest', manifest['files'][0])

    def test_delete_source_copy_collects_digest_and_completes_full_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.jpg'
            workspace = root / 'workspace'
            workspace.mkdir()
            source.write_bytes(b'A' * (5 * 1024 * 1024) + b'B' * (5 * 1024 * 1024))
            staged = classify.stage_media_to_safety_temp(
                str(source), str(workspace), direct_source=True,
                source_paths=[str(source)], import_session='delete-with-digest', verify_copy=True,
            )
            entry = staged['entries'][0]
            self.assertTrue(staged['copyVerified'])
            self.assertEqual(len(entry['copyDigest']['chunks']), 3)
            self.assertTrue(entry['copyVerification']['complete'])

    def test_enabling_delete_for_digestless_session_keeps_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.jpg'
            workspace = root / 'workspace'
            workspace.mkdir()
            source.write_bytes(b'legacy-retained-copy')
            classify.stage_media_to_safety_temp(
                str(source), str(workspace), direct_source=True,
                source_paths=[str(source)], import_session='digestless-retry', verify_copy=False,
            )
            with mock.patch.object(classify, 'safe_chunk_copy', wraps=classify.safe_chunk_copy) as copy_file:
                resumed = classify.stage_media_to_safety_temp(
                    str(source), str(workspace), direct_source=True,
                    source_paths=[str(source)], import_session='digestless-retry', verify_copy=True,
                )
            self.assertTrue(source.is_file())
            self.assertTrue(resumed['copyVerified'])
            self.assertTrue(any(call.kwargs.get('collect_digest') is True for call in copy_file.call_args_list))

    def test_digestless_session_with_offline_source_continues_but_blocks_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.jpg'
            workspace = root / 'workspace'
            workspace.mkdir()
            source.write_bytes(b'offline-after-plan')
            initial = classify.stage_media_to_safety_temp(
                str(source), str(workspace), direct_source=True,
                source_paths=[str(source)], import_session='digestless-offline', verify_copy=False,
            )
            source.unlink()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                resumed = classify.stage_media_to_safety_temp(
                    str(source), str(workspace), direct_source=True,
                    source_paths=[str(source)], import_session='digestless-offline', verify_copy=True,
                )
            events = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith('{')]
            warning = next(event for event in events if event.get('type') == 'warning')
            self.assertEqual(warning['data']['code'], 'source_cleanup_unverified')
            self.assertFalse(warning['data']['sourceCleanupAllowed'])
            self.assertEqual(resumed['sourceCleanupBlockedReason'], 'verification-unavailable')
            self.assertFalse(resumed['copyVerified'])
            self.assertTrue(Path(initial['stagedFiles'][0]).is_file())

    def test_plan_then_delete_import_collects_digest_during_initial_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'card' / 'photo.jpg'
            project = root / 'project'
            source.parent.mkdir()
            project.mkdir()
            source.write_bytes(b'plan-delete-source')
            session = 'plan-delete-regression'

            with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(
                classify, 'safe_chunk_copy', wraps=classify.safe_chunk_copy,
            ) as copy_file:
                classify.stage_plan_import(
                    str(source), str(project), '[]', direct_source=True,
                    source_paths=[str(source)], import_session=session, delete_source=True,
                )
            self.assertTrue(any(call.kwargs.get('collect_digest') is True for call in copy_file.call_args_list))
            staging = Path(classify.get_import_staging_dir(str(project), session))
            manifest = json.loads((staging / classify.STAGING_MANIFEST_NAME).read_text(encoding='utf-8'))
            self.assertIn('copyDigest', manifest['files'][0])

            with contextlib.redirect_stdout(io.StringIO()):
                classify.stage_import_and_organize(
                    str(source), str(project), direct_project=True, direct_source=True,
                    source_paths=[str(source)], delete_source=True, import_session=session,
                )
            self.assertFalse(source.exists())
            self.assertEqual((project / 'jpg' / 'photo.jpg').read_bytes(), b'plan-delete-source')

    def test_plan_cli_forwards_delete_source_to_digest_collection_policy(self):
        with mock.patch.object(classify.sys, 'platform', 'linux'), \
                mock.patch.object(classify, 'stage_plan_import') as plan:
            classify.run(['--stage', 'plan', '--delete_source'])
        self.assertIs(plan.call_args.args[-1], True)

    def test_tool_outputs_must_be_unique_regular_nonempty_files_inside_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / 'target'
            target.mkdir()
            valid = target / 'one.mp4'
            valid.write_bytes(FAKE_MP4_BYTES)
            outside = root / 'outside.mp4'
            outside.write_bytes(FAKE_MP4_BYTES)
            self.assertEqual(classify.validate_tool_output_paths([str(valid)], str(target)), [str(valid)])
            with self.assertRaisesRegex(ValueError, '重复'):
                classify.validate_tool_output_paths([str(valid), str(valid)], str(target))
            with self.assertRaisesRegex(ValueError, '目标树'):
                classify.validate_tool_output_paths([str(outside)], str(target))
            empty = target / 'empty.mp4'
            empty.touch()
            with self.assertRaisesRegex(ValueError, '普通非空'):
                classify.validate_tool_output_paths([str(empty)], str(target))
            text_output = target / 'segment.txt'
            text_output.write_bytes(b'not-video')
            with self.assertRaisesRegex(ValueError, '扩展名'):
                classify.validate_tool_output_paths([str(text_output)], str(target))
            fake_mp4 = target / 'fake.mp4'
            fake_mp4.write_bytes(b'not-an-mp4-container')
            with self.assertRaisesRegex(ValueError, '容器签名'):
                classify.validate_tool_output_paths([str(fake_mp4)], str(target))
            realpath = os.path.realpath
            with mock.patch.object(
                classify.os.path, 'realpath',
                side_effect=lambda value: str(outside) if os.path.abspath(value) == os.path.abspath(valid) else realpath(value),
            ), self.assertRaisesRegex(ValueError, '目标树'):
                classify.validate_tool_output_paths([str(valid)], str(target))

    def test_copy_verification_resumes_only_unfinished_chunks(self):
        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary) / 'copy.bin'
            copied.write_bytes(b'a' * 4 + b'b' * 4 + b'c' * 4)
            info = copied.stat()
            signature = {
                'canonicalPath': os.path.normcase(os.path.realpath(str(copied))),
                'device': int(info.st_dev), 'fileId': int(info.st_ino),
                'size': info.st_size, 'mtimeNs': info.st_mtime_ns,
            }
            entry = {
                'size': 12,
                'copyDigest': {'algorithm': 'sha256', 'chunkSize': 4, 'chunks': [
                    hashlib.sha256(b'a' * 4).hexdigest(),
                    hashlib.sha256(b'b' * 4).hexdigest(),
                    hashlib.sha256(b'c' * 4).hexdigest(),
                ]},
                'copyVerification': {'targetSignature': signature, 'verifiedChunks': 2},
            }
            reads = []

            class TrackingReader:
                def __init__(self, wrapped): self.wrapped = wrapped
                def __enter__(self): return self
                def __exit__(self, *args): self.wrapped.close()
                def seek(self, offset): reads.append(('seek', offset)); return self.wrapped.seek(offset)
                def read(self, size=-1): reads.append(('read', size)); return self.wrapped.read(size)

            builtin_open = open
            with mock.patch.object(classify, 'open', side_effect=lambda path, mode='r', **kwargs: TrackingReader(builtin_open(path, mode, **kwargs))):
                self.assertTrue(classify._verify_entry_copy_chunks(entry, str(copied)))
            self.assertEqual(reads[0], ('seek', 8))

    def test_copy_verification_does_not_reuse_signature_for_different_target_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staged = root / 'staged.bin'
            committed = root / 'committed.bin'
            correct = b'A' * 4 + b'B' * 4 + b'C' * 4
            damaged = b'A' * 4 + b'X' * 4 + b'C' * 4
            staged.write_bytes(correct)
            committed.write_bytes(damaged)
            timestamp = time.time() - 60
            os.utime(staged, (timestamp, timestamp))
            os.utime(committed, (timestamp, timestamp))
            staged_info = staged.stat()
            entry = {
                'size': len(correct),
                'copyDigest': {'algorithm': 'sha256', 'chunkSize': 4, 'chunks': [
                    hashlib.sha256(correct[index:index + 4]).hexdigest() for index in range(0, len(correct), 4)
                ]},
                'copyVerification': {
                    'targetSignature': {
                        'canonicalPath': os.path.normcase(os.path.realpath(str(staged))),
                        'device': int(staged_info.st_dev), 'fileId': int(staged_info.st_ino),
                        'size': staged_info.st_size, 'mtimeNs': staged_info.st_mtime_ns,
                    },
                    'verifiedChunks': 3,
                    'complete': True,
                },
            }
            self.assertFalse(classify._verify_entry_copy_chunks(entry, str(committed)))
            self.assertNotIn('copyVerification', entry)

    def test_hundred_gib_verification_throttles_25600_chunks_to_bounded_checkpoints(self):
        chunk_size = 4 * 1024 * 1024
        chunk_count = 25_600
        entry = {
            'size': chunk_size * chunk_count,
            'copyDigest': {'algorithm': 'sha256', 'chunkSize': chunk_size, 'chunks': ['digest'] * chunk_count},
        }
        checkpoint = mock.Mock()
        throttle = classify.VerificationCheckpointThrottle(
            checkpoint,
            interval_seconds=10_000,
            interval_bytes=2 * 1024 * 1024 * 1024,
            clock=lambda: 0.0,
        )

        class SyntheticHundredGibReader:
            def __init__(self): self.blocks = 0
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def seek(self, _offset): return None
            def read(self, size=-1):
                if size == chunk_size and self.blocks < chunk_count:
                    self.blocks += 1
                    return synthetic_block
                return b''

        class SyntheticBlock:
            def __len__(self): return chunk_size

        synthetic_block = SyntheticBlock()
        fake_stat = mock.Mock(st_size=entry['size'], st_mtime_ns=123, st_dev=7, st_ino=11)
        fake_digest = mock.Mock(hexdigest=mock.Mock(return_value='digest'))
        with mock.patch.object(classify, '_regular_file_without_links', return_value=True), \
                mock.patch.object(classify.os, 'lstat', return_value=fake_stat), \
                mock.patch.object(classify, 'open', return_value=SyntheticHundredGibReader()), \
                mock.patch.object(classify.hashlib, 'sha256', return_value=fake_digest):
            self.assertTrue(classify._verify_entry_copy_chunks(entry, 'synthetic.bin', throttle))
            throttle.flush(force=True)

        self.assertEqual(checkpoint.call_count, 50)
        self.assertLess(checkpoint.call_count, chunk_count // 100)

    def test_slow_hundred_gib_verification_is_not_time_checkpointed(self):
        checkpoints = []
        clock_value = [0.0]

        def slow_clock():
            clock_value[0] += 60.0
            return clock_value[0]

        throttle = classify.VerificationCheckpointThrottle(
            lambda: checkpoints.append(1), interval_bytes=2 * 1024 * 1024 * 1024,
            interval_seconds=3, clock=slow_clock,
        )
        for _ in range(25_600):
            throttle.advance(4 * 1024 * 1024)
        throttle.flush(force=True)
        self.assertEqual(len(checkpoints), 50)

    def test_clearable_copy_fsyncs_before_digest_can_authorize_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.bin'
            source.write_bytes(b'fsync-required')
            with mock.patch.object(classify.os, 'fsync') as fsync:
                classify.safe_chunk_copy(str(source), str(root / 'retained.bin'), collect_digest=False)
                fsync.assert_not_called()
                classify.safe_chunk_copy(str(source), str(root / 'clearable.bin'), collect_digest=True)
                self.assertEqual(fsync.call_count, 1)

    def test_broll_promotion_journal_write_volume_is_linear_for_500_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            staging = Path(temporary)
            entries = [
                {'source': f'source-{index}.jpg', 'staged': str(staging / f'{index}.jpg'), 'size': 1}
                for index in range(500)
            ]
            staged_import = {'stagingDir': str(staging), 'entries': entries}
            (staging / classify.STAGING_MANIFEST_NAME).write_text(json.dumps({'version': 2, 'files': entries}), encoding='utf-8')
            with mock.patch.object(classify.os, 'fsync'), mock.patch.object(classify, '_write_staging_manifest') as rewrite:
                for index, entry in enumerate(entries):
                    destination = str(staging / 'target' / f'{index}.jpg')
                    classify.journal_staged_entry(staged_import, entry, {'pendingDestination': destination})
                    classify.journal_staged_entry(staged_import, entry, {'pendingDestination': None, 'committedDestination': destination})
            rewrite.assert_not_called()
            journal = staging / classify.STAGING_PATCH_JOURNAL_NAME
            self.assertLess(journal.stat().st_size, 300_000)
            manifest = json.loads((staging / classify.STAGING_MANIFEST_NAME).read_text(encoding='utf-8'))
            replayed = classify._replay_staging_patch_journal(str(staging), manifest)
            self.assertEqual(replayed['files'][499]['committedDestination'], str(staging / 'target' / '499.jpg'))

    def test_real_temporary_file_verification_uses_one_final_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.bin'
            copied = root / 'copied.bin'
            block = b'photoflow-checkpoint-benchmark' * 4096
            with source.open('wb') as output:
                for _ in range(512):
                    output.write(block)
            digest = classify.safe_chunk_copy(str(source), str(copied), collect_digest=True)
            entry = {'size': source.stat().st_size, 'copyDigest': digest}
            checkpoint = mock.Mock()
            throttle = classify.VerificationCheckpointThrottle(checkpoint)

            started = time.perf_counter()
            self.assertTrue(classify._verify_entry_copy_chunks(entry, str(copied), throttle))
            throttle.flush(force=True)
            elapsed = time.perf_counter() - started

            self.assertEqual(checkpoint.call_count, 1)
            self.assertGreater(entry['size'] / max(elapsed, 0.001), 8 * 1024 * 1024)

    def test_staging_manifest_identity_is_stable_and_old_receipt_remains_readable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            card = root / 'card'
            card.mkdir()
            source = card / 'one.jpg'
            source.write_bytes(b'image')
            first = classify.stage_media_to_safety_temp(str(card), str(root), direct_source=True, source_paths=[str(source)], import_session='stable')
            manifest_path = Path(first['stagingDir']) / classify.STAGING_MANIFEST_NAME
            identity = json.loads(manifest_path.read_text(encoding='utf-8'))['manifestIdentity']
            second = classify.load_staged_import(str(root), 'stable')
            self.assertIsNotNone(second)
            self.assertEqual(json.loads(manifest_path.read_text(encoding='utf-8'))['manifestIdentity'], identity)

            receipt_path = Path(first['stagingDir']) / classify.IMPORT_GRAPH_RECEIPT_NAME
            receipt_path.write_text(json.dumps({'receiptVersion': 1, 'importSessionId': 'old', 'manifests': []}), encoding='utf-8')
            self.assertEqual(classify.load_import_graph_receipt(first['stagingDir'])['importSessionId'], 'old')

    def test_manifest_rejects_link_or_junction_project_route(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / 'linked-project'
            media = project / 'jpg' / 'one.jpg'
            media.parent.mkdir(parents=True)
            media.write_bytes(b'image')
            with mock.patch.object(
                classify, '_real_path_inside',
                return_value=False,
            ):
                with self.assertRaisesRegex(ValueError, '符号链接|junction'):
                    classify.build_import_graph_manifest(str(root), str(project), project.name, 'linked', [str(media)])

    def test_manifest_planning_allows_safe_uncreated_slot_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / 'future-project'
            future_media = project / 'jpg' / 'one.jpg'
            manifest = classify.build_import_graph_manifest(
                str(root), str(project), project.name, 'future', [str(future_media)],
            )
            self.assertEqual(manifest['artifacts'][0]['relativePath'], 'jpg')

    @unittest.skipUnless(os.name == 'nt', 'Windows junction behavior')
    def test_authorized_workspace_root_junction_is_allowed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real_workspace = root / 'real-workspace'
            alias = root / 'workspace-alias'
            project = real_workspace / 'project'
            project.mkdir(parents=True)
            completed = subprocess.run(
                ['cmd', '/c', 'mklink', '/J', str(alias), str(real_workspace)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            if completed.returncode != 0:
                self.skipTest('junction creation unavailable')
            try:
                self.assertTrue(classify._safe_directory_target(str(alias), str(alias / 'project')))
            finally:
                os.rmdir(alias)

    @unittest.skipUnless(os.name == 'nt', 'Windows junction behavior')
    def test_child_junction_escaping_canonical_workspace_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / 'workspace'
            outside = root / 'outside'
            escape = workspace / 'escape'
            workspace.mkdir()
            (outside / 'project').mkdir(parents=True)
            completed = subprocess.run(
                ['cmd', '/c', 'mklink', '/J', str(escape), str(outside)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            if completed.returncode != 0:
                self.skipTest('junction creation unavailable')
            try:
                self.assertFalse(classify._safe_directory_target(str(workspace), str(escape / 'project')))
            finally:
                os.rmdir(escape)

    def test_same_named_projects_receive_distinct_stable_receipt_manifest_ids(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            projects = [root / 'a' / 'same-name', root / 'b' / 'same-name']
            manifests = []
            for project in projects:
                media = project / 'jpg' / 'one.jpg'
                media.parent.mkdir(parents=True)
                media.write_bytes(b'image')
                manifests.append(classify.build_import_graph_manifest(
                    str(root), str(project), project.name, 'same-session', [str(media)],
                ))
            receipt_dir = root / 'receipt'
            self.assertEqual(len({manifest['manifestId'] for manifest in manifests}), 2)
            classify.write_import_graph_receipt(str(receipt_dir), 'same-session', manifests)
            receipt = classify.load_import_graph_receipt(str(receipt_dir))
            ids = [manifest['manifestId'] for manifest in receipt['manifests']]
            self.assertEqual(len(set(ids)), 2)
            self.assertEqual(receipt['manifestIdentities'], ids)

            second_dir = root / 'receipt-again'
            second = [
                classify.build_import_graph_manifest(str(root), str(project), project.name, 'same-session', [str(project / 'jpg' / 'one.jpg')])
                for project in projects
            ]
            classify.write_import_graph_receipt(str(second_dir), 'same-session', second)
            self.assertEqual(
                [manifest['manifestId'] for manifest in classify.load_import_graph_receipt(str(second_dir))['manifests']],
                ids,
            )

    def test_import_fails_before_copy_when_disk_space_is_insufficient(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dcim = root / 'card' / 'DCIM'
            workspace = root / 'workspace'
            dcim.mkdir(parents=True)
            workspace.mkdir()
            (dcim / 'photo.jpg').write_bytes(b'image')
            usage = mock.Mock(total=100, used=100, free=0)

            with mock.patch.object(classify.shutil, 'disk_usage', return_value=usage), \
                    mock.patch.object(classify, 'safe_chunk_copy') as copy_file:
                with self.assertRaisesRegex(OSError, '磁盘空间不足'):
                    classify.stage_media_to_safety_temp(str(root / 'card'), str(workspace), import_session='no-space')

            copy_file.assert_not_called()

    def test_discard_and_expiry_remove_abandoned_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = 'discard-me'
            staging = Path(classify.get_import_staging_dir(str(root), session))
            staging.mkdir(parents=True)
            manifest = staging / classify.STAGING_MANIFEST_NAME
            manifest.write_text('{"version": 2, "files": []}', encoding='utf-8')

            classify.discard_import_session(str(root), session)
            self.assertFalse(staging.exists())

            expired = Path(classify.get_import_staging_dir(str(root), 'expired'))
            expired.mkdir(parents=True)
            expired_manifest = expired / classify.STAGING_MANIFEST_NAME
            expired_manifest.write_text('{"version": 2, "files": []}', encoding='utf-8')
            old = time.time() - classify.STAGING_RETENTION_SECONDS - 1
            os.utime(expired_manifest, (old, old))
            self.assertEqual(classify.cleanup_expired_import_staging(str(root)), 1)
            self.assertFalse(expired.exists())


if __name__ == '__main__':
    unittest.main()
