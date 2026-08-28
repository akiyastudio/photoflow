export type VideoAspectMode = 'source' | 'contain' | 'cover' | '16:9' | '4:3' | '1:1';
export type VideoRotation = 0 | 90 | 180 | 270;
export type VideoTransform = { aspectMode: VideoAspectMode; rotation: VideoRotation; flipHorizontal: boolean; flipVertical: boolean };
export type VideoHdrMode = 'auto' | 'sdr' | 'hdr-passthrough' | 'tone-map';
export type VideoStatisticsLevel = 'off' | 'basic' | 'detailed';

export const DEFAULT_VIDEO_TRANSFORM: VideoTransform = { aspectMode: 'contain', rotation: 0, flipHorizontal: false, flipVertical: false };
export const normalizeVideoTransform = (value?: Partial<VideoTransform>): VideoTransform => ({
  aspectMode: ['source', 'contain', 'cover', '16:9', '4:3', '1:1'].includes(String(value?.aspectMode)) ? value!.aspectMode! : 'contain',
  rotation: [0, 90, 180, 270].includes(Number(value?.rotation)) ? Number(value!.rotation) as VideoRotation : 0,
  flipHorizontal: value?.flipHorizontal === true,
  flipVertical: value?.flipVertical === true,
});
export const chromiumVideoStyle = (value: VideoTransform): Record<string, string | number | undefined> => {
  const ratio = value.aspectMode === '16:9' ? '16 / 9' : value.aspectMode === '4:3' ? '4 / 3' : value.aspectMode === '1:1' ? '1 / 1' : undefined;
  return {
    objectFit: value.aspectMode === 'cover' ? 'cover' : 'contain',
    aspectRatio: ratio,
    width: ratio ? '100%' : '100%', height: ratio ? 'auto' : '100%', maxWidth: '100%', maxHeight: '100%',
    transform: `rotate(${value.rotation}deg) scaleX(${value.flipHorizontal ? -1 : 1}) scaleY(${value.flipVertical ? -1 : 1})`,
  };
};
export const hdrModeAvailability = ({ requested, backendModes, hdrDisplayAvailable }: { requested: VideoHdrMode; backendModes: VideoHdrMode[]; hdrDisplayAvailable: boolean }) => {
  if (!backendModes.includes(requested)) return { available: false, reason: '当前播放后端不支持此 HDR 模式' };
  if (requested === 'hdr-passthrough' && !hdrDisplayAvailable) return { available: false, reason: '当前显示器未报告可用 HDR 输出' };
  return { available: true, reason: '' };
};

export const transformedFrameSize = (width: number, height: number, value: VideoTransform) => {
  const rotated = value.rotation === 90 || value.rotation === 270;
  const sourceWidth = rotated ? height : width; const sourceHeight = rotated ? width : height;
  const ratio = value.aspectMode === '16:9' ? 16 / 9 : value.aspectMode === '4:3' ? 4 / 3 : value.aspectMode === '1:1' ? 1 : sourceWidth / Math.max(1, sourceHeight);
  return sourceWidth / Math.max(1, sourceHeight) > ratio
    ? { width: Math.max(1, Math.round(sourceHeight * ratio)), height: sourceHeight }
    : { width: sourceWidth, height: Math.max(1, Math.round(sourceWidth / ratio)) };
};

export const drawTransformedVideoFrame = (context: CanvasRenderingContext2D, video: HTMLVideoElement, value: VideoTransform) => {
  const { width, height } = transformedFrameSize(video.videoWidth, video.videoHeight, value);
  context.save(); context.translate(width / 2, height / 2); context.rotate(value.rotation * Math.PI / 180); context.scale(value.flipHorizontal ? -1 : 1, value.flipVertical ? -1 : 1);
  const rotated = value.rotation === 90 || value.rotation === 270;
  const boxWidth = rotated ? height : width; const boxHeight = rotated ? width : height;
  const scale = value.aspectMode === 'cover' ? Math.max(boxWidth / video.videoWidth, boxHeight / video.videoHeight) : Math.min(boxWidth / video.videoWidth, boxHeight / video.videoHeight);
  const drawWidth = video.videoWidth * scale; const drawHeight = video.videoHeight * scale;
  context.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight); context.restore();
  return { width, height };
};
