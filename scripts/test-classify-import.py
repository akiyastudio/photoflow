import datetime
import contextlib
import errno
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))

import classify  # noqa: E402
import ffmpeg_transcode  # noqa: E402


class ClassifyImportTests(unittest.TestCase):
    def tearDown(self):
        classify.CANCEL_FILE = ''
        classify.EXIFTOOL_PATH = ''
        classify.CAPTURE_TIME_MEMORY_CACHE.clear()
        classify.get_file_time.cache_clear()

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

            def disconnect_on_second(source, target, chunk_size=4 * 1024 * 1024, on_progress=None):
                if Path(source).name == 'two.jpg':
                    Path(target).write_bytes(b'partial')
                    raise OSError('device disconnected')
                return original_copy(source, target, chunk_size, on_progress)

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
                    str(source), '--video-mode', 'h265',
                    '--source-folder', str(source_folder),
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
                    str(source), '--source-folder', str(source_folder), '--output-mode', 'replace',
                ])
            self.assertEqual(replace_code, 1)
            self.assertIn('文件夹转码任务不能替换原视频', replace_output.getvalue())

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

    def test_video_preview_only_processes_current_import_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            source_dir = target / 'mov'
            source_dir.mkdir()
            old_video = source_dir / 'old.mov'
            new_video = source_dir / 'new.mov'
            old_video.write_bytes(b'old')
            new_video.write_bytes(b'new')
            with mock.patch.object(classify, 'transcode_video_preview', return_value='libx264') as transcode:
                result = classify.generate_video_previews(str(target), source_paths=[str(new_video)])

            self.assertEqual(result, (1, 1))
            self.assertEqual(transcode.call_count, 1)
            self.assertEqual(transcode.call_args.args[0], str(new_video))
            self.assertNotEqual(transcode.call_args.args[0], str(old_video))

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
