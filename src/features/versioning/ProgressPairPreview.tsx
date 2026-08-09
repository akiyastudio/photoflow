import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AppConfig } from '../../types';

export type ProgressPairPreviewMode = 'side-by-side' | 'overlay';

type ProgressPairPreviewProps = {
  referencePath?: string;
  sourcePath?: string;
  referenceLabel?: string;
  sourceLabel?: string;
  referenceMissing?: boolean;
  mode: ProgressPairPreviewMode;
  swapped: boolean;
  cacheConfig: AppConfig['mediaCache'];
  onModeChange: (mode: ProgressPairPreviewMode) => void;
  onSwappedChange: (swapped: boolean) => void;
};

const previewKind = (filePath: string): 'image' | 'raw' | 'video' => {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLocaleLowerCase();
  if (new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.crm']).has(extension)) return 'video';
  if (new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']).has(extension)) return 'raw';
  return 'image';
};

const clampZoom = (value: number) => Math.max(1, Math.min(5, value));

export const ProgressPairPreview = ({ referencePath = '', sourcePath = '', referenceLabel = '上一版本', sourceLabel = '当前版本', referenceMissing = false, mode, swapped, cacheConfig, onModeChange, onSwappedChange }: ProgressPairPreviewProps) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [resources, setResources] = useState<{ reference?: string; source?: string; loading: boolean; error?: string }>({ loading: false });
  const requestSequenceRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    const requestSequence = ++requestSequenceRef.current;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setResources({ loading: Boolean((referencePath && !referenceMissing) || sourcePath) });
    const paths = new Map<string, 'reference' | 'source'>();
    if (referencePath && !referenceMissing) paths.set(referencePath.toLocaleLowerCase(), 'reference');
    if (sourcePath) paths.set(sourcePath.toLocaleLowerCase(), 'source');
    const unsubscribe = window.electronAPI.onThumbnailStateChanged(update => {
      if (requestSequenceRef.current !== requestSequence || update.state !== 'READY') return;
      const side = paths.get(update.filePath.toLocaleLowerCase());
      const url = update.previewUrls?.large || update.previewUrls?.medium;
      if (side && url) setResources(current => ({ ...current, [side]: url }));
    });
    Promise.all([
      referencePath && !referenceMissing ? window.electronAPI.getMediaThumbnail(referencePath, previewKind(referencePath), cacheConfig, 1600, 0, -2) : Promise.resolve(undefined),
      sourcePath ? window.electronAPI.getMediaThumbnail(sourcePath, previewKind(sourcePath), cacheConfig, 1600, 0, -1) : Promise.resolve(undefined),
    ]).then(([reference, source]) => {
      if (requestSequenceRef.current !== requestSequence) return;
      setResources({
        reference: reference?.previewUrl || reference?.mediaUrl,
        source: source?.previewUrl || source?.mediaUrl,
        loading: false,
        error: reference && !reference.success || source && !source.success ? reference?.error || source?.error || '对比预览加载失败' : undefined,
      });
    }).catch(error => {
      if (requestSequenceRef.current === requestSequence) setResources({ loading: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      requestSequenceRef.current += 1;
      unsubscribe();
      if (referencePath && !referenceMissing) void window.electronAPI.cancelMediaThumbnail(referencePath, 1600);
      if (sourcePath) void window.electronAPI.cancelMediaThumbnail(sourcePath, 1600);
    };
  }, [referencePath, sourcePath, referenceMissing, cacheConfig.directory, cacheConfig.maxSizeGB]);

  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const imageStyle = { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center' };
  const image = (url: string | undefined, label: string, missing: boolean) => missing
    ? <div className="tracking-confirmation-missing">{referencePath ? '上一版本引用不可用，请重新定位或拒绝。' : '未关联上一版本'}</div>
    : url ? <img src={url} alt={label} draggable={false} style={imageStyle} className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain transition-transform duration-75"/>
    : <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">{resources.loading ? <Loader2 size={22} className="animate-spin"/> : '没有可用预览'}</div>;
  const panes = swapped
    ? [{ label: sourceLabel, image: image(resources.source, sourceLabel, false) }, { label: referenceLabel, image: image(resources.reference, referenceLabel, referenceMissing) }]
    : [{ label: referenceLabel, image: image(resources.reference, referenceLabel, referenceMissing) }, { label: sourceLabel, image: image(resources.source, sourceLabel, false) }];

  return <section className="tracking-confirmation-preview">
    <header className="tracking-confirmation-preview-toolbar">
      <div className="flex items-center gap-1 rounded-lg bg-slate-800 p-1 text-xs"><button type="button" onClick={() => onModeChange('side-by-side')} className={`rounded px-2 py-1 ${mode === 'side-by-side' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>并排</button><button type="button" onClick={() => onModeChange('overlay')} className={`rounded px-2 py-1 ${mode === 'overlay' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>叠加</button><button type="button" onClick={() => onSwappedChange(!swapped)} className="rounded px-2 py-1 text-slate-300 hover:bg-slate-700">交换</button></div>
      <div className="flex items-center gap-1 text-xs text-slate-300"><button type="button" onClick={() => setZoom(current => clampZoom(current / 1.2))} className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">−</button><button type="button" onClick={resetView} title="适合窗口" className="min-w-14 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">{Math.round(zoom * 100)}%</button><button type="button" onClick={() => setZoom(current => clampZoom(current * 1.2))} className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">＋</button></div>
    </header>
    <div onWheel={event => { event.preventDefault(); setZoom(current => clampZoom(current * (event.deltaY < 0 ? 1.15 : .87))); }} onPointerDown={event => { if (zoom <= 1 || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; }} onPointerMove={event => { const drag = dragRef.current; if (drag) setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y }); }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} className={`tracking-confirmation-preview-stage ${mode === 'overlay' ? 'is-overlay' : ''} ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}>
      {panes.map((pane, index) => <div key={`${pane.label}-${index}`} className="tracking-confirmation-preview-pane"><span className="tracking-confirmation-preview-label">{pane.label}</span>{pane.image}</div>)}
    </div>
    {resources.error && <p className="border-t border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">{resources.error}</p>}
  </section>;
};
