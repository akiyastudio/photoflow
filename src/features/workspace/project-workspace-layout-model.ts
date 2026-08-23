type ProjectColumnWidths = { files: number; preview: number; metadata: number };

export const scheduleAfterProjectPaint = (delayMs: number, callback: () => void) => {
  let timer = 0;
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(callback, delayMs);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
};

export const clampNumber = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export const fitProjectColumnWidths = (preferred: ProjectColumnWidths, containerWidth: number, previewOpen: boolean, metadataOpen: boolean) => {
  const handleCount = Number(previewOpen) + Number(metadataOpen);
  const available = Math.max(0, containerWidth - handleCount);
  const preferredTotal = preferred.files + (previewOpen ? preferred.preview : 0) + (metadataOpen ? preferred.metadata : 0);
  if (!previewOpen && !metadataOpen) return { ...preferred, files: available };
  if (preferredTotal <= 0) return preferred;
  if (available >= preferredTotal) return { ...preferred, files: preferred.files + available - preferredTotal };
  const scale = available / preferredTotal;
  return {
    files: preferred.files * scale,
    preview: previewOpen ? preferred.preview * scale : preferred.preview,
    metadata: metadataOpen ? preferred.metadata * scale : preferred.metadata,
  };
};

export const readStoredNumber = (key: string, fallback: number) => {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

export const readStoredBoolean = (key: string, fallback: boolean) => {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
};
