import { useCallback, useEffect, useState } from 'react';
import type { ComponentSettingsPageContribution, ComponentStatus } from '../../types';
import { readCachedComponentStatuses } from './component-cache';
import { componentHostCatalogKey } from './useComponentPages';

type UseComponentCatalogOptions = {
  onError: (message: string) => void;
  onSettingsPagesChanged: (pages: ComponentSettingsPageContribution[]) => void;
};

const cacheComponents = (components: ComponentStatus[]) => {
  window.localStorage.setItem('photoflow:components-cache', JSON.stringify(components));
};

export const useComponentCatalog = ({ onError, onSettingsPagesChanged }: UseComponentCatalogOptions) => {
  const [components, setComponents] = useState<ComponentStatus[]>(readCachedComponentStatuses);
  const [componentInstallPath, setComponentInstallPath] = useState('');
  const [componentsLoading, setComponentsLoading] = useState(true);
  const [componentSettingsPages, setComponentSettingsPages] = useState<ComponentSettingsPageContribution[]>([]);
  const catalogKey = componentHostCatalogKey(components);

  const refreshComponents = useCallback(async (force = false) => {
    setComponentsLoading(true);
    try {
      const result = await window.electronAPI.getComponents(force);
      if (!result.success) throw new Error(result.error || '无法读取组件状态');
      const nextComponents = result.components || [];
      setComponents(nextComponents);
      cacheComponents(nextComponents);
      setComponentInstallPath(result.installPath || '');
    } catch (error) {
      setComponents([]);
      onError(`读取组件状态失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setComponentsLoading(false);
    }
  }, [onError]);

  const handleComponentsChanged = useCallback(async () => {
    await refreshComponents(true);
    window.dispatchEvent(new Event('photoflow-components-changed'));
  }, [refreshComponents]);

  useEffect(() => {
    let active = true;
    void window.electronAPI.getComponentSettingsPages().then(result => {
      if (!active) return;
      const pages = result.success ? result.pages || [] : [];
      setComponentSettingsPages(pages);
      onSettingsPagesChanged(pages);
    }).catch(() => {
      if (!active) return;
      setComponentSettingsPages([]);
    });
    return () => { active = false; };
  }, [catalogKey, onSettingsPagesChanged]);

  useEffect(() => { void refreshComponents(); }, [refreshComponents]);

  useEffect(() => window.electronAPI.onComponentsStatusChanged(result => {
    if (!result.success) return;
    const nextComponents = result.components || [];
    setComponents(nextComponents);
    cacheComponents(nextComponents);
    setComponentInstallPath(result.installPath || '');
  }), []);

  return { components, componentInstallPath, componentsLoading, componentSettingsPages, refreshComponents, handleComponentsChanged };
};
