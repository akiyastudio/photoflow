import assert from 'node:assert/strict';
import {
  BUILTIN_VIDEO_TRANSCODE_PRESETS, formatMediaBytes, normalizeVideoTranscodeSettings,
  readCustomVideoTranscodePresets, videoTranscodeWarnings, writeCustomVideoTranscodePresets,
} from '../src/features/tools/video-transcode-model.ts';

const legacy = normalizeVideoTranscodeSettings({ videoMode: 'h265', audioMode: 'copy' });
assert.equal(legacy.colorMode, 'auto');
assert.equal(legacy.retryCount, 1);
assert.equal(BUILTIN_VIDEO_TRANSCODE_PRESETS.length, 5);
assert.equal(formatMediaBytes(1024 ** 3), '1.00 GiB');
assert(videoTranscodeWarnings({ ...legacy, videoMode: 'av1' }, { av1Hardware: false, hevc10Bit: false, hdrToneMap: true, subtitleBurn: true, encoders: [], pixelFormats: {}, filters: [] }).some(value => value.includes('AV1')));

const values = new Map();
const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
writeCustomVideoTranscodePresets(storage, [{ id: 'mine', name: '我的 HDR', settings: legacy }]);
assert.equal(readCustomVideoTranscodePresets(storage)[0].name, '我的 HDR');
console.log('Video transcode model tests passed.');
