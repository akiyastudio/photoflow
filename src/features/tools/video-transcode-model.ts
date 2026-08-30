import type { VideoTranscodeSettings } from '../../types';

export type VideoTranscodePreset = {
  id: string;
  name: string;
  builtIn?: boolean;
  settings: VideoTranscodeSettings;
};

export type VideoTranscodeMediaInfo = {
  path: string;
  name: string;
  duration: number;
  sizeBytes: number;
  estimatedOutputBytes: number;
  codec: string;
  profile: string;
  pixelFormat: string;
  bitDepth: number;
  width: number;
  height: number;
  frameRate: number;
  sar: string;
  dar: string;
  rotation: number;
  transfer: string;
  primaries: string;
  matrix: string;
  range: string;
  hdr: boolean;
  hdrKind: string;
  dynamicHdr?: string;
  audioTracks: number;
  subtitleTracks: number;
};

export type VideoTranscodeCapabilities = {
  encoders: string[];
  usableHardwareEncoders?: string[];
  usableHardware10BitEncoders?: string[];
  pixelFormats: Record<string, string[]>;
  filters: string[];
  hdrToneMap: boolean;
  subtitleBurn: boolean;
  av1Hardware: boolean;
  hevc10Bit: boolean;
};

export const DEFAULT_VIDEO_TRANSCODE_SETTINGS: VideoTranscodeSettings = {
  container: 'mp4', videoMode: 'h264', quality: 'balanced', resolution: 'original',
  frameRate: 'original', audioMode: 'aac', subtitleMode: 'copy', colorMode: 'auto',
  bitDepth: 'auto', frameRateMode: 'preserve', rotation: 'auto', aspectMode: 'preserve',
  audioTrack: 'all', videoBitrateMbps: null, audioBitrateKbps: 192,
  encoderPreset: 'balanced', retryCount: 1,
};

export const normalizeVideoTranscodeSettings = (value?: Partial<VideoTranscodeSettings> | null): VideoTranscodeSettings => {
  const migratedColorMode = value?.colorMode === 'hdr-to-sdr' ? 'sdr' : value?.colorMode;
  const videoMode = value?.videoMode || DEFAULT_VIDEO_TRANSCODE_SETTINGS.videoMode;
  return {
    ...DEFAULT_VIDEO_TRANSCODE_SETTINGS,
    ...(value || {}),
    ...(migratedColorMode ? { colorMode: migratedColorMode } : {}),
    ...(['hdr10', 'hlg'].includes(String(migratedColorMode)) ? { bitDepth: '10' as const } : {}),
    videoBitrateMbps: videoMode === 'prores' || videoMode === 'copy' ? null : Number(value?.videoBitrateMbps) > 0 ? Number(value?.videoBitrateMbps) : null,
    retryCount: 1,
  };
};

const preset = (id: string, name: string, settings: Partial<VideoTranscodeSettings>): VideoTranscodePreset => ({
  id, name, builtIn: true, settings: normalizeVideoTranscodeSettings(settings),
});

export const BUILTIN_VIDEO_TRANSCODE_PRESETS: VideoTranscodePreset[] = [
  preset('h264-compatible', 'H.264 通用兼容', { videoMode: 'h264', colorMode: 'sdr', bitDepth: '8', container: 'mp4' }),
  preset('hevc-main10', 'HEVC Main10 · 跟随来源', { videoMode: 'h265', colorMode: 'auto', bitDepth: '10', container: 'mp4', quality: 'high' }),
  preset('hdr-to-sdr', 'Rec.709 SDR 输出', { videoMode: 'h265', colorMode: 'sdr', bitDepth: '8', container: 'mp4' }),
  preset('av1-hardware', 'AV1 硬件高效', { videoMode: 'av1', colorMode: 'auto', bitDepth: '10', container: 'mp4' }),
  preset('prores-master', 'ProRes 422 HQ 母版', { videoMode: 'prores', colorMode: 'auto', bitDepth: '10', container: 'mov', quality: 'high', audioMode: 'copy' }),
];

const CUSTOM_PRESET_STORAGE_KEY = 'photoflow:video-transcode-presets:v1';

export const readCustomVideoTranscodePresets = (storage: Pick<Storage, 'getItem'>): VideoTranscodePreset[] => {
  try {
    const parsed = JSON.parse(storage.getItem(CUSTOM_PRESET_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 30).flatMap(item => {
      const id = typeof item?.id === 'string' ? item.id.slice(0, 80) : '';
      const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 40) : '';
      return id && name && item?.settings ? [{ id, name, settings: normalizeVideoTranscodeSettings(item.settings) }] : [];
    });
  } catch { return []; }
};

export const writeCustomVideoTranscodePresets = (storage: Pick<Storage, 'setItem'>, presets: VideoTranscodePreset[]) => {
  storage.setItem(CUSTOM_PRESET_STORAGE_KEY, JSON.stringify(presets.filter(value => !value.builtIn).slice(0, 30)));
};

export const formatMediaBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** unit;
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

export const videoTranscodeBlockingErrors = (
  settings: VideoTranscodeSettings,
  capabilities?: VideoTranscodeCapabilities | null,
  mediaInfo: VideoTranscodeMediaInfo[] = [],
) => {
  const errors: string[] = [];
  const hasHdrSource = mediaInfo.some(item => item.hdr);
  if (settings.videoMode === 'h264' && ['hdr10', 'hlg'].includes(settings.colorMode)) errors.push('H.264 不支持此 HDR 输出设置；请选择 HEVC、AV1 或 ProRes。');
  if (settings.videoMode === 'h264' && settings.bitDepth === '10') errors.push('H.264 10-bit 兼容性过低；请选择 HEVC、AV1 或 ProRes。');
  if (settings.videoMode === 'h264' && settings.colorMode === 'auto' && hasHdrSource) errors.push('H.264 无法保留队列中的 HDR；请选择 HEVC、AV1、ProRes，或将色彩输出设为 Rec.709 SDR。');
  if (settings.videoMode === 'av1' && capabilities && !capabilities.av1Hardware) errors.push('当前设备未检测到 AV1 硬件编码器。');
  if ((settings.bitDepth === '10' || ['hdr10', 'hlg'].includes(settings.colorMode)) && capabilities && !capabilities.hevc10Bit && settings.videoMode === 'h265') errors.push('当前运行库/设备没有可用的 HEVC 10-bit 编码器。');
  if (settings.colorMode === 'sdr' && hasHdrSource && capabilities && !capabilities.hdrToneMap) errors.push('当前运行库缺少 HDR→SDR 色调映射滤镜。');
  if (settings.subtitleMode === 'burn' && capabilities && !capabilities.subtitleBurn) errors.push('当前运行库缺少字幕烧录滤镜。');
  return errors;
};

export const videoTranscodeWarnings = (settings: VideoTranscodeSettings, capabilities?: VideoTranscodeCapabilities | null, mediaInfo: VideoTranscodeMediaInfo[] = []) => {
  const warnings = videoTranscodeBlockingErrors(settings, capabilities, mediaInfo);
  if (settings.subtitleMode === 'copy' && settings.container === 'mp4') warnings.push('MP4 不能封装部分图形字幕；遇到不兼容字幕时请改用 MKV、烧录或移除。');
  if (settings.videoMode === 'copy' && settings.audioMode === 'copy' && settings.subtitleMode === 'copy') warnings.push('复制视频流不会改变画质或体积，且目标封装必须支持原始音视频与字幕编码。');
  return warnings;
};
