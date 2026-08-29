export type VideoAspectMode = 'source' | 'contain' | 'cover' | '16:9' | '4:3' | '1:1';
export type ToneMappingAlgorithm = 'auto' | 'bt2390' | 'reinhard' | 'mobius' | 'hable';

export interface MediaPlaybackBackendV1Contribution {
  type: 'media.playbackBackend';
  protocolVersion: 1;
  backendId: string;
  displayName: string;
  backendVersion: `${number}.${number}.${number}${string}`;
  transport: 'media-playback-backend-v1';
  priority: number;
  probe: { containers: string[]; codecs: { video: string[]; audio: string[] }; extensions: `.${string}`[] };
  features: {
    transforms: { aspectModes: VideoAspectMode[]; rotation: boolean; flip: boolean; crop: boolean };
    hdr: { passthrough: boolean; toneMapping: boolean; algorithms: ToneMappingAlgorithm[]; targetPeakControl: boolean };
    statistics: { basic: boolean; decode: boolean; hdr: boolean; timing: boolean; cache: boolean; gpu: boolean; maxUpdateHz: number };
    subtitles: { embedded: boolean; external: boolean; ass: boolean; styles: boolean };
    hardwareDecoding: { supported: boolean; selectable: boolean; softwareFallback: boolean };
    capture: { sourceFrame: boolean; displayedFrame: boolean };
  };
}

export interface MediaPlaybackBackendV1Envelope<TPayload extends object = Record<string, unknown>> {
  protocol: 'media-playback-backend-v1';
  protocolVersion: 1;
  sessionId: string;
  sequence: number;
  timestamp: number;
  event: `command.${string}` | `event.${string}`;
  payload: TPayload;
}
