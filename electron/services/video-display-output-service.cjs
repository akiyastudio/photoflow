const createVideoDisplayOutputService = ({ screen }) => {
  const describe = (ownerWindow, bounds = null) => {
    const target = bounds && Number(bounds.width) > 0 && Number(bounds.height) > 0 ? bounds : ownerWindow?.getBounds?.() || { x: 0, y: 0, width: 1, height: 1 };
    const display = screen.getDisplayMatching(target);
    const colorSpace = String(display?.colorSpace || '');
    const hdrAvailable = display?.hdrEnabled === true || /(?:hdr|rec(?:\.?|-)2100|pq)/i.test(colorSpace);
    return Object.freeze({
      displayId: String(display?.id ?? ''), scaleFactor: Number(display?.scaleFactor) || 1,
      colorSpace, hdrAvailable,
      reason: hdrAvailable ? '' : '当前显示器未明确报告 HDR 输出能力',
      bounds: display?.bounds || null,
    });
  };
  return { describe };
};
module.exports = { createVideoDisplayOutputService };
