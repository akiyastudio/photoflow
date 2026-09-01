// Host API v7 compatibility vocabulary. Delete with project.media.process v7 after
// shipped components and legacy renderer/import callers move to descriptor-native
// runtime execution. This module is data-only and must never execute plugin logic.
const LEGACY_MEDIA_PROCESS = Object.freeze({
  preview: 'video.sources.preview',
  inspect: 'video.transcode.inspect',
  trim: 'video.trim',
  officeExtract: 'office.extractImages',
  transcode: 'video.transcode',
  split: 'video.split',
  timelineFrames: 'video.timelineFrames',
  transcodeScript: 'ffmpeg_transcode.py',
  trimScript: 'cut_video.py',
  progressEvent: 'video-tools.operation.progress.v1',
  sourceFolderFlag: '--source-folder',
  inspectArguments: Object.freeze(['--inspect-only', '--skip-capability-probe']),
  outputModeFlag: '--output-mode',
  trimArguments: Object.freeze({ start: '--trim-start', end: '--trim-end', output: '--output-path', mode: '--trim-mode', cancel: '--cancel_file' }),
});

// Protocol-only translation for Host API v7 callers that still send `settings`.
// New component services send runtimeArgs themselves; remove this with API v7.
const legacyTranscodeRuntimeArgs = settings => {
  const value = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const text = (field, allowed, fallback) => allowed.includes(String(value[field] || '')) ? String(value[field]) : fallback;
  const bitrate = Number(value.videoBitrateMbps); const audioBitrate = Number(value.audioBitrateKbps);
  return ['--container', text('container', ['mp4', 'mov', 'mkv'], 'mp4'), '--video-mode', text('videoMode', ['h264', 'h265', 'av1', 'prores', 'copy'], 'h264'), '--quality', text('quality', ['high', 'balanced', 'small'], 'balanced'), '--resolution', text('resolution', ['original', '2160p', '1080p', '720p'], 'original'), '--frame-rate', text('frameRate', ['original', '24', '25', '30', '50', '60'], 'original'), '--audio-mode', text('audioMode', ['copy', 'aac', 'remove'], 'aac'), '--subtitle-mode', text('subtitleMode', ['copy', 'burn', 'remove'], 'copy'), '--color-mode', text('colorMode', ['auto', 'sdr', 'hdr10', 'hlg', 'hdr-to-sdr'], 'auto'), '--bit-depth', text('bitDepth', ['auto', '8', '10'], 'auto'), '--frame-rate-mode', text('frameRateMode', ['preserve', 'cfr', 'vfr'], 'preserve'), '--rotation', text('rotation', ['auto', '0', '90', '180', '270'], 'auto'), '--aspect-mode', text('aspectMode', ['preserve', 'square-pixels'], 'preserve'), '--audio-track', text('audioTrack', ['all', 'first'], 'all'), '--audio-bitrate-kbps', String([96, 128, 160, 192, 256, 320].includes(audioBitrate) ? audioBitrate : 192), '--encoder-preset', text('encoderPreset', ['fast', 'balanced', 'quality'], 'balanced'), '--retry-count', '1', ...(Number.isFinite(bitrate) && bitrate > 0 && bitrate <= 800 ? ['--video-bitrate-mbps', String(bitrate)] : [])];
};

module.exports = { LEGACY_MEDIA_PROCESS, legacyTranscodeRuntimeArgs };
