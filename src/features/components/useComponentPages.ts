import { useCallback, useEffect, useState } from 'react';
import type { ComponentHostAction, ComponentPageInstance, ComponentPageOpenScope, ComponentStatus, WorkspaceProject } from '../../types';
import { bindComponentPageInstance, closeComponentPage, closeProjectComponentPages, componentPageActivationSucceeded, componentPageIsAvailable, ensureComponentPage } from './component-page-model';

type ComponentHostBrowserPage = { id: string; projectId: string; project?: WorkspaceProject | null };

export const useComponentPages = ({ browserPages, components, onProjectFallback, onHomeFallback, onNotice }: {
  browserPages: ComponentHostBrowserPage[];
  components: ComponentStatus[];
  onProjectFallback: (page: ComponentHostBrowserPage) => void;
  onHomeFallback: () => void;
  onNotice: (message: string, duration?: number) => void;
}) => {
  const [actions, setActions] = useState<ComponentHostAction[]>([]);
  const [pages, setPages] = useState<ComponentPageInstance[]>([]);
  const [activeIdentity, setActiveIdentity] = useState('');

  useEffect(() => {
    let active = true;
    void window.electronAPI.getComponentHostActions().then(result => { if (active) setActions(result.success ? result.actions || [] : []); })
      .catch(() => { if (active) setActions([]); });
    return () => { active = false; };
  }, [components]);

  useEffect(() => {
    const installedIds = new Set(components.filter(component => component.installed).map(component => component.id));
    const unavailablePages = pages.filter(page => !installedIds.has(page.componentId));
    if (!unavailablePages.length) return;
    unavailablePages.forEach(page => { if (page.instanceId) void window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined); });
    setPages(current => current.filter(page => installedIds.has(page.componentId)));
    if (unavailablePages.some(page => page.identity === activeIdentity)) setActiveIdentity('');
  }, [activeIdentity, components, pages]);

  useEffect(() => {
    const unavailablePages = pages.filter(page => !componentPageIsAvailable(page, components));
    if (!unavailablePages.length) return;
    unavailablePages.forEach(page => { if (page.instanceId) void window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined); });
    setPages(current => current.filter(page => componentPageIsAvailable(page, components)));
    const activeUnavailable = unavailablePages.find(page => page.identity === activeIdentity);
    if (activeUnavailable) {
      setActiveIdentity('');
      const projectPage = browserPages.find(candidate => candidate.projectId === activeUnavailable.projectId && candidate.project);
      if (projectPage) onProjectFallback(projectPage); else onHomeFallback();
    }
  }, [activeIdentity, browserPages, components, onHomeFallback, onProjectFallback, pages]);

  const deactivate = useCallback(() => window.electronAPI.activateComponentPage('').catch(() => ({ success: false })), []);
  const activate = useCallback(async (page: ComponentPageInstance) => {
    const result = page.instanceId ? await window.electronAPI.activateComponentPage(page.instanceId).catch(() => ({ success: false })) : { success: false };
    if (componentPageActivationSucceeded(result)) { setActiveIdentity(page.identity); return true; }
    setPages(current => closeComponentPage(current, page.identity));
    setActiveIdentity(current => current === page.identity ? '' : current);
    onNotice('组件页已失效，请重新打开', 5000);
    const projectPage = browserPages.find(candidate => candidate.projectId === page.projectId && candidate.project);
    if (projectPage) onProjectFallback(projectPage); else onHomeFallback();
    return false;
  }, [browserPages, onHomeFallback, onNotice, onProjectFallback]);
  const open = useCallback(async (action: ComponentHostAction, project: WorkspaceProject, workspacePath: string, insertAfterTabId = 'home', scope?: ComponentPageOpenScope) => {
    const ensured = ensureComponentPage(pages, action, project, workspacePath, insertAfterTabId);
    setPages(current => ensureComponentPage(current, action, project, workspacePath, insertAfterTabId).pages);
    setActiveIdentity(ensured.page.identity);
    const result = await window.electronAPI.openComponentPage({ componentId: action.componentId, pageId: action.pageId, workspacePath, projectId: project.id, projectName: project.name, projectStatus: project.status, ...scope });
    if (!result.success || !result.page) {
      if (ensured.created) setPages(current => closeComponentPage(current, ensured.page.identity));
      setActiveIdentity(ensured.created ? '' : ensured.page.identity);
      onNotice(`打开组件页失败：${result.error || '未知错误'}`, 5000); return false;
    }
    setPages(current => bindComponentPageInstance(current, ensured.page.identity, result.page!.instanceId));
    return true;
  }, [onNotice, pages]);
  const close = useCallback(async (page: ComponentPageInstance) => {
    if (page.instanceId) await window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined);
    setPages(current => closeComponentPage(current, page.identity));
    if (activeIdentity !== page.identity) return;
    setActiveIdentity('');
    const projectPage = browserPages.find(candidate => candidate.projectId === page.projectId && candidate.project);
    if (projectPage) onProjectFallback(projectPage); else onHomeFallback();
  }, [activeIdentity, browserPages, onHomeFallback, onProjectFallback]);
  const disposeProject = useCallback((workspacePath: string, projectId: string) => {
    void window.electronAPI.closeProjectComponentPages(workspacePath, projectId);
    setPages(current => closeProjectComponentPages(current, workspacePath, projectId));
    const activePage = pages.find(candidate => candidate.identity === activeIdentity);
    if (activePage?.projectId === projectId && activePage.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() === workspacePath.replace(/\\/g, '/').toLocaleLowerCase()) setActiveIdentity('');
  }, [activeIdentity, pages]);
  return { actions, pages, activeIdentity, activate, deactivate, open, close, disposeProject };
};
