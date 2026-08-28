export type VideoAspectMode = 'source' | 'contain' | 'cover' | '16:9' | '4:3' | '1:1';
export type VideoRotation = 0 | 90 | 180 | 270;
export type VideoTransform = { aspectMode: VideoAspectMode; rotation: VideoRotation; flipHorizontal: boolean; flipVertical: boolean; crop?: { x: number; y: number; width: number; height: number } };
export type VideoHdrMode = 'auto' | 'sdr' | 'hdr-passthrough' | 'tone-map';
export type VideoToneMapping = 'auto' | 'bt2390' | 'reinhard' | 'mobius' | 'hable';
export type VideoStatisticsLevel = 'off' | 'basic' | 'detailed';

export const DEFAULT_VIDEO_TRANSFORM: VideoTransform = { aspectMode: 'contain', rotation: 0, flipHorizontal: false, flipVertical: false };
export const normalizeVideoTransform = (value?: Partial<VideoTransform>): VideoTransform => ({
  aspectMode: ['source', 'contain', 'cover', '16:9', '4:3', '1:1'].includes(String(value?.aspectMode)) ? value!.aspectMode! : 'contain',
  rotation: [0, 90, 180, 270].includes(Number(value?.rotation)) ? Number(value!.rotation) as VideoRotation : 0,
  flipHorizontal: value?.flipHorizontal === true,
  flipVertical: value?.flipVertical === true,
  ...(value?.crop && [value.crop.x,value.crop.y,value.crop.width,value.crop.height].every(Number.isFinite) ? { crop: { x: Math.max(0,Math.min(1,value.crop.x)), y: Math.max(0,Math.min(1,value.crop.y)), width: Math.max(0.001,Math.min(1,value.crop.width)), height: Math.max(0.001,Math.min(1,value.crop.height)) } } : {}),
});
export const chromiumVideoStyle = (value: VideoTransform): Record<string, string | number | undefined> => {
  const ratio = value.aspectMode === '16:9' ? '16 / 9' : value.aspectMode === '4:3' ? '4 / 3' : value.aspectMode === '1:1' ? '1 / 1' : undefined;
  return {
    objectFit: value.aspectMode === 'cover' ? 'cover' : 'contain',
    aspectRatio: ratio,
    width: ratio ? '100%' : '100%', height: ratio ? 'auto' : '100%', maxWidth: '100%', maxHeight: '100%',
    transform: `rotate(${value.rotation}deg) scaleX(${value.flipHorizontal ? -1 : 1}) scaleY(${value.flipVertical ? -1 : 1})`,
    clipPath:value.crop?`inset(${value.crop.y*100}% ${(1-value.crop.x-value.crop.width)*100}% ${(1-value.crop.y-value.crop.height)*100}% ${value.crop.x*100}%)`:undefined,
  };
};
export const hdrModeAvailability = ({ requested, hdrFeatures, hdrDisplayAvailable, toneMapping }: { requested: VideoHdrMode; hdrFeatures?: {passthrough:boolean;toneMapping:boolean;algorithms:string[];targetPeakControl:boolean}; hdrDisplayAvailable: boolean;toneMapping?:VideoToneMapping }) => {
  if (requested === 'hdr-passthrough' && !hdrFeatures?.passthrough) return { available: false, reason: '当前播放后端不支持 HDR 直通' };
  if (requested === 'hdr-passthrough' && !hdrDisplayAvailable) return { available: false, reason: '当前显示器未报告可用 HDR 输出' };
  if (requested === 'tone-map' && (!hdrFeatures?.toneMapping || !hdrFeatures.algorithms.includes(toneMapping||'auto'))) return {available:false,reason:'当前播放后端不支持所选色调映射算法'};
  return { available: true, reason: '' };
};
export const playbackCapabilityPresentation = (features: { transforms: {aspectModes:string[];rotation:boolean;flip:boolean;crop:boolean}; hdr: {passthrough:boolean;toneMapping:boolean;algorithms:string[];targetPeakControl:boolean}; statistics:{basic:boolean;decode:boolean;hdr:boolean;timing:boolean;cache:boolean;gpu:boolean}; subtitles:{embedded:boolean;external:boolean;ass:boolean;styles:boolean}; capture:{sourceFrame:boolean;displayedFrame:boolean} } | undefined, hdrDisplayAvailable: boolean) => ({
  transformControls: features?.transforms.aspectModes || [], rotationAvailable:features?.transforms.rotation===true,flipAvailable:features?.transforms.flip===true,cropAvailable:features?.transforms.crop===true,
  hdrPassthroughAvailable:features?.hdr.passthrough===true&&hdrDisplayAvailable,toneMappingAvailable:features?.hdr.toneMapping===true,toneMappingAlgorithms:features?.hdr.algorithms||[],targetPeakControl:features?.hdr.targetPeakControl===true,
  statisticsGroups:features?.statistics||{basic:false,decode:false,hdr:false,timing:false,cache:false,gpu:false},
  subtitleFormats:[...(features?.subtitles.external?['vtt','srt']:[]),...(features?.subtitles.ass?['ass','ssa']:[])],
  captureAvailable: features?.capture.displayedFrame === true,displayedCaptureAvailable:features?.capture.displayedFrame===true,
});

export const transformedFrameSize = (width: number, height: number, value: VideoTransform) => {
  width*=value.crop?.width||1;height*=value.crop?.height||1;
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
  const effectiveWidth=video.videoWidth*(value.crop?.width||1),effectiveHeight=video.videoHeight*(value.crop?.height||1);const scale = value.aspectMode === 'cover' ? Math.max(boxWidth / effectiveWidth, boxHeight / effectiveHeight) : Math.min(boxWidth / effectiveWidth, boxHeight / effectiveHeight);
  const drawWidth = effectiveWidth * scale; const drawHeight = effectiveHeight * scale;
  if(value.crop){const sx=video.videoWidth*value.crop.x,sy=video.videoHeight*value.crop.y,sw=video.videoWidth*value.crop.width,sh=video.videoHeight*value.crop.height;context.drawImage(video,sx,sy,sw,sh,-drawWidth/2,-drawHeight/2,drawWidth,drawHeight);}else context.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight); context.restore();
  return { width, height };
};
