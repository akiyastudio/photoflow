import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export type CropRectangle = { x: number; y: number; width: number; height: number };
type CropHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

const InteractiveCropEditor = ({ previewUrl, imageSize, crop, onChange, large = false, snapGuides = { x: [], y: [] }, snapEnabled = false }: { previewUrl: string; imageSize: { width: number; height: number }; crop: CropRectangle; onChange: (crop: CropRectangle) => void; large?: boolean; snapGuides?: { x: number[]; y: number[] }; snapEnabled?: boolean }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ pointerId: number; handle: CropHandle; x: number; y: number; crop: CropRectangle } | null>(null);
  const minimumSize = Math.max(40, Math.round(Math.min(imageSize.width, imageSize.height) * .025));
  const handleSize = Math.max(40, Math.min(imageSize.width, imageSize.height) / 28);
  const snapDistance = Math.max(8, Math.round(Math.min(imageSize.width, imageSize.height) * .018));
  const [activeGuides, setActiveGuides] = useState<{ x?: number; y?: number }>({});
  const nearestGuide = (value: number, guides: number[]) => {
    let best: { value: number; distance: number } | undefined;
    for (const guide of guides) {
      const distance = Math.abs(value - guide);
      if (distance <= snapDistance && (!best || distance < best.distance)) best = { value: guide, distance };
    }
    return best;
  };
  const imagePoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  };
  const beginDrag = (event: ReactPointerEvent<SVGElement>, handle: CropHandle) => {
    event.preventDefault(); event.stopPropagation();
    const point = imagePoint(event.clientX, event.clientY);
    svgRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, handle, x: point.x, y: point.y, crop: { ...crop } };
  };
  const moveDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = imagePoint(event.clientX, event.clientY);
    const dx = point.x - drag.x; const dy = point.y - drag.y;
    if (drag.handle === 'move') {
      let x = Math.max(0, Math.min(imageSize.width - drag.crop.width, drag.crop.x + dx));
      let y = Math.max(0, Math.min(imageSize.height - drag.crop.height, drag.crop.y + dy));
      const leftSnap = snapEnabled ? nearestGuide(x, snapGuides.x) : undefined;
      const rightSnap = snapEnabled ? nearestGuide(x + drag.crop.width, snapGuides.x) : undefined;
      const xSnap = !leftSnap ? rightSnap && { value: rightSnap.value - drag.crop.width, guide: rightSnap.value, distance: rightSnap.distance } : !rightSnap || leftSnap.distance <= rightSnap.distance ? { value: leftSnap.value, guide: leftSnap.value, distance: leftSnap.distance } : { value: rightSnap.value - drag.crop.width, guide: rightSnap.value, distance: rightSnap.distance };
      const topSnap = snapEnabled ? nearestGuide(y, snapGuides.y) : undefined;
      const bottomSnap = snapEnabled ? nearestGuide(y + drag.crop.height, snapGuides.y) : undefined;
      const ySnap = !topSnap ? bottomSnap && { value: bottomSnap.value - drag.crop.height, guide: bottomSnap.value, distance: bottomSnap.distance } : !bottomSnap || topSnap.distance <= bottomSnap.distance ? { value: topSnap.value, guide: topSnap.value, distance: topSnap.distance } : { value: bottomSnap.value - drag.crop.height, guide: bottomSnap.value, distance: bottomSnap.distance };
      if (xSnap) x = Math.max(0, Math.min(imageSize.width - drag.crop.width, xSnap.value));
      if (ySnap) y = Math.max(0, Math.min(imageSize.height - drag.crop.height, ySnap.value));
      setActiveGuides({ x: xSnap?.guide, y: ySnap?.guide });
      onChange({ ...drag.crop, x: Math.round(x), y: Math.round(y) });
      return;
    }
    let left = drag.crop.x; let top = drag.crop.y; let right = drag.crop.x + drag.crop.width; let bottom = drag.crop.y + drag.crop.height;
    if (drag.handle.includes('w')) left = Math.max(0, Math.min(right - minimumSize, drag.crop.x + dx));
    if (drag.handle.includes('e')) right = Math.min(imageSize.width, Math.max(left + minimumSize, drag.crop.x + drag.crop.width + dx));
    if (drag.handle.includes('n')) top = Math.max(0, Math.min(bottom - minimumSize, drag.crop.y + dy));
    if (drag.handle.includes('s')) bottom = Math.min(imageSize.height, Math.max(top + minimumSize, drag.crop.y + drag.crop.height + dy));
    const horizontalEdge = drag.handle.includes('w') ? left : right;
    const verticalEdge = drag.handle.includes('n') ? top : bottom;
    const xSnap = snapEnabled ? nearestGuide(horizontalEdge, snapGuides.x) : undefined;
    const ySnap = snapEnabled ? nearestGuide(verticalEdge, snapGuides.y) : undefined;
    if (xSnap) { if (drag.handle.includes('w')) left = Math.min(right - minimumSize, xSnap.value); else right = Math.max(left + minimumSize, xSnap.value); }
    if (ySnap) { if (drag.handle.includes('n')) top = Math.min(bottom - minimumSize, ySnap.value); else bottom = Math.max(top + minimumSize, ySnap.value); }
    setActiveGuides({ x: xSnap?.value, y: ySnap?.value });
    onChange({ x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) });
  };
  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setActiveGuides({});
  };
  const corners: Array<{ handle: Exclude<CropHandle, 'move'>; x: number; y: number; cursor: string }> = [
    { handle: 'nw', x: crop.x, y: crop.y, cursor: 'nwse-resize' }, { handle: 'ne', x: crop.x + crop.width, y: crop.y, cursor: 'nesw-resize' },
    { handle: 'sw', x: crop.x, y: crop.y + crop.height, cursor: 'nesw-resize' }, { handle: 'se', x: crop.x + crop.width, y: crop.y + crop.height, cursor: 'nwse-resize' },
  ];
  return <div className={`mt-4 flex justify-center overflow-hidden rounded-xl bg-slate-950 ${large ? 'h-[68vh] max-h-[760px] min-h-[420px]' : 'max-h-80'}`}><svg ref={svgRef} className={`${large ? 'h-full' : 'max-h-80'} w-full select-none touch-none`} viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
    <image href={previewUrl} width={imageSize.width} height={imageSize.height} pointerEvents="none"/>
    {activeGuides.x !== undefined && <line x1={activeGuides.x} y1="0" x2={activeGuides.x} y2={imageSize.height} stroke="#22d3ee" strokeWidth={Math.max(2, imageSize.width / 1000)} strokeDasharray={`${Math.max(8, imageSize.width / 120)} ${Math.max(6, imageSize.width / 180)}`} pointerEvents="none"/>}
    {activeGuides.y !== undefined && <line x1="0" y1={activeGuides.y} x2={imageSize.width} y2={activeGuides.y} stroke="#22d3ee" strokeWidth={Math.max(2, imageSize.width / 1000)} strokeDasharray={`${Math.max(8, imageSize.width / 120)} ${Math.max(6, imageSize.width / 180)}`} pointerEvents="none"/>}
    <path d={`M0 0H${imageSize.width}V${imageSize.height}H0Z M${crop.x} ${crop.y}V${crop.y + crop.height}H${crop.x + crop.width}V${crop.y}Z`} fill="rgba(2,6,23,.55)" fillRule="evenodd" pointerEvents="none"/>
    <rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} fill="rgba(37,99,235,.1)" stroke="#60a5fa" strokeWidth={Math.max(3, imageSize.width / 800)} style={{ cursor: 'move' }} onPointerDown={event => beginDrag(event, 'move')}/>
    {corners.map(corner => <rect key={corner.handle} x={corner.x - handleSize / 2} y={corner.y - handleSize / 2} width={handleSize} height={handleSize} rx={handleSize * .16} fill="#fff" stroke="#2563eb" strokeWidth={Math.max(3, imageSize.width / 900)} style={{ cursor: corner.cursor }} onPointerDown={event => beginDrag(event, corner.handle)}/>)}
  </svg></div>;
};

export { InteractiveCropEditor };
