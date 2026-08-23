import { useCallback, useEffect, useState } from 'react';
import type { ComponentHostAction, ComponentPageInstance, ComponentStatus, WorkspaceProject } from '../../types';
import { bindComponentPageInstance, closeComponentPage, closeProjectComponentPages, ensureComponentPage } from './component-page-model';

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

  const deactivate = useCallback(() => { void window.electronAPI.activateComponentPage(''); }, []);
  const activate = useCallback((page: ComponentPageInstance) => {
    setActiveIdentity(page.identity);
    if (page.instanceId) void window.electronAPI.activateComponentPage(page.instanceId);
  }, []);
  const open = useCallback(async (action: ComponentHostAction, project: WorkspaceProject, workspacePath: string) => {
    const ensured = ensureComponentPage(pages, action, project, workspacePath);
    setPages(current => ensureComponentPage(current, action, project, workspacePath).pages);
    setActiveIdentity(ensured.page.identity);
    const result = await window.electronAPI.openComponentPage({ componentId: action.componentId, pageId: action.pageId, workspacePath, projectId: project.id, projectName: project.name });
    if (!result.success || !result.page) {
      setPages(current => closeComponentPage(current, ensured.page.identity)); setActiveIdentity('');
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
