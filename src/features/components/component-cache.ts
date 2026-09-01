import type { ComponentStatus } from '../../types';

export const readCachedComponentStatuses = (): ComponentStatus[] => {
  try {
    const cached = JSON.parse(window.localStorage.getItem('photoflow:components-cache') || '[]');
    return Array.isArray(cached)
      ? cached.filter(component => component && !['application', 'legacy-application', 'bundled'].includes(String(component.source || '')))
      : [];
  } catch {
    return [];
  }
};
