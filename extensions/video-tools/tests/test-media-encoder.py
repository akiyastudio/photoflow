import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'runtime'))
import ffmpeg_transcode


class MediaEncoderLiteTests(unittest.TestCase):
    def test_automatic_inspection_can_defer_capability_probe(self):
        emitted = []
        with mock.patch.object(ffmpeg_transcode, 'available_transcode_capabilities') as capabilities, \
                mock.patch.object(ffmpeg_transcode, '_emit_cli', side_effect=lambda *args, **kwargs: emitted.append((args, kwargs))):
            result = ffmpeg_transcode.run(['--inspect-only', '--skip-capability-probe'])
        self.assertEqual(result, 0)
        capabilities.assert_not_called()
        self.assertEqual(emitted[-1][1]['capabilities'], {})

    def test_probe_parses_hdr10_ten_bit_tracks_and_geometry(self):
        summary = """
Duration: 00:01:02.50, start: 0.000000, bitrate: 52000 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160 [SAR 1:1 DAR 16:9], 59.94 fps, 50000 kb/s
    rotation of -90.00 degrees
  Stream #0:1: Audio: aac, 48000 Hz, stereo, 192 kb/s
  Stream #0:2: Audio: pcm_s24le, 48000 Hz, stereo
  Stream #0:3: Subtitle: mov_text
"""
        with mock.patch.object(ffmpeg_transcode, 'probe_media_text', return_value=summary), \
                mock.patch.object(ffmpeg_transcode.os.path, 'isfile', return_value=True), \
                mock.patch.object(ffmpeg_transcode.os.path, 'getsize', return_value=1234):
            info = ffmpeg_transcode.probe_media_info('clip.mov')
        self.assertEqual(info['hdrKind'], 'HDR10')
        self.assertEqual(info['bitDepth'], 10)
        self.assertEqual((info['width'], info['height']), (3840, 2160))
        self.assertEqual(info['audioTracks'], 2)
        self.assertEqual(info['subtitleTracks'], 1)
        self.assertEqual(info['rotation'], -90)

    def test_probe_does_not_reuse_one_color_tag_for_unknown_fields(self):
        summary = """
Duration: 00:00:01.00, start: 0.000000, bitrate: 100 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(tv, bt709/unknown/unknown, progressive), 128x72, 1 fps
"""
        with mock.patch.object(ffmpeg_transcode, 'probe_media_text', return_value=summary), \
                mock.patch.object(ffmpeg_transcode.os.path, 'isfile', return_value=True), \
                mock.patch.object(ffmpeg_transcode.os.path, 'getsize', return_value=1234):
            info = ffmpeg_transcode.probe_media_info('clip.mp4')
        self.assertEqual(info['matrix'], 'bt709')
        self.assertEqual(info['primaries'], 'unknown')
        self.assertEqual(info['transfer'], 'unknown')

    def test_hdr10_hevc_command_is_ten_bit_and_tagged(self):
        command = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'clip.mov', 'clip.mp4', video_mode='h265', encoder='hevc_nvenc',
            color_mode='hdr10', bit_depth='10', subtitle_mode='remove',
        )
        self.assertEqual(command[command.index('-pix_fmt') + 1], 'p010le')
        self.assertEqual(command[command.index('-color_trc') + 1], 'smpte2084')
        self.assertEqual(command[command.index('-color_primaries') + 1], 'bt2020')
        self.assertEqual(command[command.index('-tag:v') + 1], 'hvc1')

    def test_tone_map_subtitle_tracks_and_safe_custom_bitrate(self):
        command = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', "C:/media/clip's.mov", 'clip.mkv', video_mode='h265',
            encoder='libx265', color_mode='sdr', bit_depth='8',
            subtitle_mode='burn', audio_track='first', video_bitrate_mbps=12.5,
            frame_rate_mode='cfr', frame_rate='30', rotation='90', aspect_mode='square-pixels',
            source_hdr=True, source_transfer='smpte2084', source_primaries='bt2020', source_matrix='bt2020nc',
        )
        filters = command[command.index('-vf') + 1]
        self.assertIn('zscale=t=linear', filters)
        self.assertIn('tonemap=tonemap=hable', filters)
        self.assertIn('subtitles=', filters)
        self.assertIn('fps=30', filters)
        self.assertIn('transpose=clock', filters)
        self.assertIn('setsar=1', filters)
        self.assertIn('0:a:0?', command)
        self.assertEqual(command[command.index('-maxrate') + 1], '12.5M')
        self.assertNotIn('-crf', command)

    def test_rec709_output_only_tone_maps_hdr_sources(self):
        sdr = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'in.mp4', 'out.mp4', color_mode='sdr', bit_depth='8',
        )
        hdr = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'in.mp4', 'out.mp4', video_mode='h265', encoder='libx265', color_mode='sdr', bit_depth='10',
            source_hdr=True, source_transfer='smpte2084', source_primaries='bt2020', source_matrix='bt2020nc',
        )
        self.assertNotIn('tonemap=', sdr[sdr.index('-vf') + 1])
        self.assertIn('colorprim=bt709', sdr[sdr.index('-x264-params') + 1])
        self.assertIn('tonemap=tonemap=hable', hdr[hdr.index('-vf') + 1])
        self.assertEqual(hdr[hdr.index('-pix_fmt') + 1], 'yuv420p10le')
        self.assertIn('transfer=bt709', hdr[hdr.index('-x265-params') + 1])

    def test_hdr_output_converts_a_different_source_transfer(self):
        command = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'in.mp4', 'out.mp4', video_mode='h265', encoder='libx265',
            color_mode='hdr10', bit_depth='10', source_hdr=True,
            source_transfer='arib-std-b67', source_primaries='bt2020', source_matrix='bt2020nc',
        )
        filters = command[command.index('-vf') + 1]
        self.assertIn('zscale=t=linear', filters)
        self.assertIn('zscale=t=smpte2084:m=bt2020nc', filters)

    def test_preserve_timestamps_does_not_apply_a_hidden_target_rate(self):
        command = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'in.mp4', 'out.mp4', frame_rate_mode='preserve', frame_rate='30',
        )
        self.assertNotIn('fps=30', command[command.index('-vf') + 1])

    def test_av1_and_prores_commands(self):
        av1 = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'in.mkv', 'out.mp4', video_mode='av1', encoder='av1_nvenc',
            color_mode='sdr', bit_depth='8',
        )
        self.assertIn('av1_nvenc', av1)
        prores = ffmpeg_transcode.build_general_transcode_command(
            'ffmpeg', 'in.mkv', 'out.mov', container='mov', video_mode='prores',
            color_mode='sdr', bit_depth='10', quality='high',
        )
        self.assertIn('prores_ks', prores)
        self.assertEqual(prores[prores.index('-pix_fmt') + 1], 'yuv422p10le')
        self.assertEqual(prores[prores.index('-profile:v') + 1], '3')

    def test_output_estimate_uses_explicit_rate(self):
        estimated = ffmpeg_transcode.estimate_transcode_size_bytes(
            {'duration': 60, 'width': 1920, 'height': 1080, 'frameRate': 30, 'audioTracks': 1},
            {'video_mode': 'h265', 'quality': 'balanced', 'audio_mode': 'aac', 'audio_bitrate_kbps': 192, 'video_bitrate_mbps': 10},
        )
        self.assertGreater(estimated, 76_000_000)
        self.assertLess(estimated, 79_000_000)


if __name__ == '__main__':
    unittest.main()
