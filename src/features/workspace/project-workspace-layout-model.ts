type ProjectColumnWidths = { files: number; preview: number; metadata: number };

export type FileListColumnWidths = { name: number; modified: number; type: number; size: number };
export type FileListColumnBoundary = 0 | 1 | 2 | 3;

export const FILE_LIST_COLUMN_KEYS = ['name', 'modified', 'type', 'size'] as const;
export const DEFAULT_FILE_LIST_COLUMN_WIDTHS: FileListColumnWidths = { name: 420, modified: 220, type: 170, size: 110 };
export const MIN_FILE_LIST_COLUMN_WIDTHS: FileListColumnWidths = { name: 24, modified: 24, type: 24, size: 24 };
// Three 16px gaps plus 10px inline padding on both sides of each grid row.
export const FILE_LIST_GRID_CHROME_WIDTH = 68;

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

export const fitFileListColumnWidths = (preferred: FileListColumnWidths, availableWidth: number): FileListColumnWidths => {
  const normalized = Object.fromEntries(FILE_LIST_COLUMN_KEYS.map(key => {
    const value = Number(preferred[key]);
    return [key, Number.isFinite(value) && value > 0 ? value : DEFAULT_FILE_LIST_COLUMN_WIDTHS[key]];
  })) as FileListColumnWidths;
  const minimumTotal = FILE_LIST_COLUMN_KEYS.reduce((total, key) => total + MIN_FILE_LIST_COLUMN_WIDTHS[key], 0);
  const targetWidth = Math.max(minimumTotal, Number.isFinite(availableWidth) ? availableWidth : minimumTotal);
  const result = {} as FileListColumnWidths;
  let remainingWidth = targetWidth;
  let activeKeys = [...FILE_LIST_COLUMN_KEYS];

  while (activeKeys.length) {
    const activeWeight = activeKeys.reduce((total, key) => total + normalized[key], 0);
    const constrained = activeKeys.filter(key => activeWeight <= 0 || remainingWidth * normalized[key] / activeWeight < MIN_FILE_LIST_COLUMN_WIDTHS[key]);
    if (!constrained.length) {
      for (const key of activeKeys) result[key] = remainingWidth * normalized[key] / activeWeight;
      break;
    }
    for (const key of constrained) {
      result[key] = MIN_FILE_LIST_COLUMN_WIDTHS[key];
      remainingWidth -= result[key];
    }
    activeKeys = activeKeys.filter(key => !constrained.includes(key));
  }
  return result;
};

export const resizeFileListColumnBoundary = (widths: FileListColumnWidths, boundary: FileListColumnBoundary, deltaX: number): FileListColumnWidths => {
  const key = FILE_LIST_COLUMN_KEYS[boundary];
  const safeDelta = Math.max(MIN_FILE_LIST_COLUMN_WIDTHS[key] - widths[key], Number.isFinite(deltaX) ? deltaX : 0);
  return {
    ...widths,
    [key]: widths[key] + safeDelta,
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
