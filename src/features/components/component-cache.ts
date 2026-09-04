import type { ComponentStatus } from '../../types';

export const readCachedComponentStatuses = (): ComponentStatus[] => {
  try {
    const cached = JSON.parse(window.localStorage.getItem('photoflow:components-cache') || '[]');
    return Array.isArray(cached)
      ? cached.slice(0, 512).filter((component): component is ComponentStatus => Boolean(component && typeof component === 'object'
        && typeof component.id === 'string' && component.id.length <= 80
        && typeof component.version === 'string' && component.version.length <= 80
        && typeof component.installed === 'boolean' && typeof component.compatible === 'boolean'
        && !['application', 'legacy-application', 'bundled'].includes(String(component.source || ''))))
      : [];
  } catch {
    return [];
  }
};
