import { useEffect, useRef } from 'react';
import type { ThumbnailState } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';

export const requestThumbnail = <T,>(task: () => Promise<T>) => task();
const thumbnailSizeLabel = (requestedSize: number) => requestedSize <= 320 ? 'small' : requestedSize <= 640 ? 'medium' : 'large';
const mediaThumbnailPreviewCache = new Map<string, string>();

export const getMediaThumbnailPreview = (key: string) => mediaThumbnailPreviewCache.get(key);
export const deleteMediaThumbnailPreview = (key: string) => mediaThumbnailPreviewCache.delete(key);

export const mediaThumbnailPreviewKey = (filePath: string, updatedAt: number, requestedSize: number) => `${filePath.toLocaleLowerCase()}|${updatedAt}|${requestedSize}`;

export const forgetMediaThumbnailPreviews = (filePath: string) => {
  const prefix = `${filePath.toLocaleLowerCase()}|`;
  for (const key of mediaThumbnailPreviewCache.keys()) if (key.startsWith(prefix)) mediaThumbnailPreviewCache.delete(key);
};

export const rememberMediaThumbnailPreview = (key: string, url: string) => {
  if (mediaThumbnailPreviewCache.size >= 2000 && !mediaThumbnailPreviewCache.has(key)) {
    mediaThumbnailPreviewCache.delete(mediaThumbnailPreviewCache.keys().next().value as string);
  }
  mediaThumbnailPreviewCache.set(key, url);
};

export const findCachedMediaThumbnailPreview = (filePath: string, updatedAt: number) => {
  const prefix = `${filePath.toLocaleLowerCase()}|${updatedAt}|`;
  const matches = [...mediaThumbnailPreviewCache.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, url]) => ({ url, size: Number(key.slice(prefix.length)) || 0 }))
    .sort((left, right) => right.size - left.size);
  return matches[0];
};

export const useThumbnailUpdates = (
  filePath: string,
  requestedSize: number,
  onUpdate: (state: ThumbnailState, url?: string) => void,
) => {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const sizeLabel = thumbnailSizeLabel(requestedSize);
  useEffect(() => projectWorkspaceClient.onThumbnailStateChanged(update => {
    if (update.filePath.toLocaleLowerCase() !== filePath.toLocaleLowerCase()) return;
    onUpdateRef.current(update.state, update.previewUrls?.[sizeLabel]);
  }), [filePath, sizeLabel]);
};
