import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentContribution, ComponentHostAction, ComponentPageInstance, ComponentPageOpenScope, ComponentStatus, WorkspaceProject } from '../../types';
import { bindComponentPageInstance, closeComponentPage, closeProjectComponentPages, componentPageActivationSucceeded, componentPageIsAvailable, ensureComponentPage } from './component-page-model';
import { useUserFacingToast } from '../app/useUserFacingToast';

type ComponentHostBrowserPage = { id: string; projectId: string; kind: 'project' | 'inspiration'; project?: WorkspaceProject | null };

export const componentHostCatalogKey = (components: ComponentStatus[]) => components
  .map(component => [component.id, component.version, component.installed ? 1 : 0, component.enabled === false ? 0 : 1, component.compatible ? 1 : 0, component.status || ''].join(':'))
  .sort()
  .join('|');

export const useComponentPages = ({ browserPages, components, onProjectFallback, onHomeFallback }: {
  browserPages: ComponentHostBrowserPage[];
  components: ComponentStatus[];
  onProjectFallback: (page: ComponentHostBrowserPage) => void;
  onHomeFallback: () => void;
}) => {
  const toast = useUserFacingToast();
  const [actions, setActions] = useState<ComponentHostAction[]>([]);
  const [contributions, setContributions] = useState<ComponentContribution[]>([]);
  const [pages, setPages] = useState<ComponentPageInstance[]>([]);
  const [activeIdentity, setActiveIdentity] = useState('');
  const activeIdentityRef = useRef('');
  const activationGeneration = useRef(0);
  const openGenerations = useRef(new Map<string, number>());
  const inflightOpens = useRef(new Map<string, Promise<boolean>>());
  const inflightOwners = useRef(new Map<string, symbol>());
  const inflightFingerprints = useRef(new Map<string, string>());
  const openScopes = useRef(new Map<string, { workspacePath: string; projectId: string }>());
  const catalogKey = componentHostCatalogKey(components);

  useEffect(() => {
    let active = true;
    void window.electronAPI.getComponentHostActions().then(result => { if (active) setActions(result.success ? result.actions || [] : []); })
      .catch(() => { if (active) setActions([]); });
    return () => { active = false; };
  }, [catalogKey]);
  useEffect(() => { let active = true; void window.electronAPI.getComponentContributions().then(result => { if (active) setContributions(result.success ? result.contributions || [] : []); }).catch(() => { if (active) setContributions([]); }); return () => { active = false; }; }, [catalogKey]);
  useEffect(() => { activeIdentityRef.current = activeIdentity; }, [activeIdentity]);

  useEffect(() => {
    const installedIds = new Set(components.filter(component => component.installed && component.enabled !== false).map(component => component.id));
    const unavailablePages = pages.filter(page => !installedIds.has(page.componentId));
    if (!unavailablePages.length) return;
    unavailablePages.forEach(page => openGenerations.current.set(page.identity, (openGenerations.current.get(page.identity) || 0) + 1));
    unavailablePages.forEach(page => { if (page.instanceId) void window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined); });
    setPages(current => current.filter(page => installedIds.has(page.componentId)));
    if (unavailablePages.some(page => page.identity === activeIdentity)) { activeIdentityRef.current = ''; setActiveIdentity(''); }
  }, [activeIdentity, components, pages]);

  useEffect(() => {
    const unavailablePages = pages.filter(page => !componentPageIsAvailable(page, components));
    if (!unavailablePages.length) return;
    unavailablePages.forEach(page => openGenerations.current.set(page.identity, (openGenerations.current.get(page.identity) || 0) + 1));
    unavailablePages.forEach(page => { if (page.instanceId) void window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined); });
    setPages(current => current.filter(page => componentPageIsAvailable(page, components)));
    const activeUnavailable = unavailablePages.find(page => page.identity === activeIdentity);
    if (activeUnavailable) {
      activeIdentityRef.current = ''; setActiveIdentity('');
      const browserPage = browserPages.find(candidate => candidate.projectId === activeUnavailable.projectId);
      if (browserPage) onProjectFallback(browserPage); else onHomeFallback();
    }
  }, [activeIdentity, browserPages, components, onHomeFallback, onProjectFallback, pages]);

  const deactivate = useCallback(() => { activationGeneration.current += 1; activeIdentityRef.current = ''; return window.electronAPI.activateComponentPage('').catch(() => ({ success: false })); }, []);
  const activate = useCallback(async (page: ComponentPageInstance) => {
    const generation = ++activationGeneration.current;
    const result = page.instanceId ? await window.electronAPI.activateComponentPage(page.instanceId).catch(() => ({ success: false })) : { success: false };
    if (generation !== activationGeneration.current) return false;
    if (componentPageActivationSucceeded(result)) { activeIdentityRef.current = page.identity; setActiveIdentity(page.identity); return true; }
    if (page.instanceId) void window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined);
    setPages(current => closeComponentPage(current, page.identity));
    setActiveIdentity(current => { const next = current === page.identity ? '' : current; activeIdentityRef.current = next; return next; });
    toast.show('组件页已失效，请重新打开', { tone: 'warning', dedupeKey: 'component-page-stale' });
    const browserPage = browserPages.find(candidate => candidate.projectId === page.projectId);
    if (browserPage) onProjectFallback(browserPage); else onHomeFallback();
    return false;
  }, [browserPages, onHomeFallback, onProjectFallback, toast]);
  const open = useCallback((action: ComponentHostAction, project: WorkspaceProject, workspacePath: string, insertAfterTabId = 'home', scope?: ComponentPageOpenScope) => {
    const ensured = ensureComponentPage(pages, action, project, workspacePath, insertAfterTabId);
    const fingerprint = JSON.stringify({ workspacePath, projectId: project.id, scope: scope || null });
    const inflight = inflightOpens.current.get(ensured.page.identity);
    if (inflight && inflightFingerprints.current.get(ensured.page.identity) === fingerprint) return inflight;
    if (inflight) inflightOpens.current.delete(ensured.page.identity);
    const generation = (openGenerations.current.get(ensured.page.identity) || 0) + 1;
    openGenerations.current.set(ensured.page.identity, generation);
    openScopes.current.set(ensured.page.identity, { workspacePath, projectId: project.id });
    setPages(current => ensureComponentPage(current, action, project, workspacePath, insertAfterTabId).pages);
    activeIdentityRef.current = ensured.page.identity;
    setActiveIdentity(ensured.page.identity);
    const owner = Symbol(ensured.page.identity);
    const operation = (async () => {
      const result = await window.electronAPI.openComponentPage({ componentId: action.componentId, pageId: action.pageId, workspacePath, projectId: project.id, projectName: project.name, projectStatus: project.status, ...scope })
        .catch(error => ({ success: false, page: undefined, error: error instanceof Error ? error.message : String(error) }));
      if (generation !== openGenerations.current.get(ensured.page.identity)) {
        if (result.page?.instanceId) void window.electronAPI.closeComponentPage(result.page.instanceId).catch(() => undefined);
        return false;
      }
      if (!result.success || !result.page) {
        if (ensured.created) setPages(current => closeComponentPage(current, ensured.page.identity));
        setActiveIdentity(current => current === ensured.page.identity && ensured.created ? '' : current);
        toast.show(`打开组件页失败：${result.error || '未知错误'}`, { tone: 'error', dedupeKey: `component-page-open:${action.componentId}:${action.pageId}` }); return false;
      }
      setPages(current => bindComponentPageInstance(current, ensured.page.identity, result.page!.instanceId));
      return true;
    })().finally(() => { if (inflightOwners.current.get(ensured.page.identity) === owner) { inflightOpens.current.delete(ensured.page.identity); inflightOwners.current.delete(ensured.page.identity); inflightFingerprints.current.delete(ensured.page.identity); openScopes.current.delete(ensured.page.identity); } });
    inflightOpens.current.set(ensured.page.identity, operation);
    inflightOwners.current.set(ensured.page.identity, owner);
    inflightFingerprints.current.set(ensured.page.identity, fingerprint);
    return operation;
  }, [pages, toast]);
  const close = useCallback(async (page: ComponentPageInstance) => {
    openGenerations.current.set(page.identity, (openGenerations.current.get(page.identity) || 0) + 1);
    inflightOpens.current.delete(page.identity); inflightOwners.current.delete(page.identity); inflightFingerprints.current.delete(page.identity); openScopes.current.delete(page.identity);
    activationGeneration.current += 1;
    if (page.instanceId) await window.electronAPI.closeComponentPage(page.instanceId).catch(() => undefined);
    setPages(current => closeComponentPage(current, page.identity));
    if (activeIdentityRef.current !== page.identity) return;
    activeIdentityRef.current = ''; setActiveIdentity('');
    const browserPage = browserPages.find(candidate => candidate.projectId === page.projectId);
    if (browserPage) onProjectFallback(browserPage); else onHomeFallback();
  }, [browserPages, onHomeFallback, onProjectFallback]);
  const disposeProject = useCallback((workspacePath: string, projectId: string) => {
    for (const page of pages) if (page.projectId === projectId && page.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() === workspacePath.replace(/\\/g, '/').toLocaleLowerCase()) openGenerations.current.set(page.identity, (openGenerations.current.get(page.identity) || 0) + 1);
    for (const [identity, scope] of openScopes.current) if (scope.projectId === projectId && scope.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() === workspacePath.replace(/\\/g, '/').toLocaleLowerCase()) openGenerations.current.set(identity, (openGenerations.current.get(identity) || 0) + 1);
    activationGeneration.current += 1;
    void window.electronAPI.closeProjectComponentPages(workspacePath, projectId).catch(() => undefined);
    setPages(current => closeProjectComponentPages(current, workspacePath, projectId));
    const activePage = pages.find(candidate => candidate.identity === activeIdentityRef.current);
    if (activePage?.projectId === projectId && activePage.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() === workspacePath.replace(/\\/g, '/').toLocaleLowerCase()) { activeIdentityRef.current = ''; setActiveIdentity(''); }
  }, [pages]);
  return { actions, contributions, pages, activeIdentity, activate, deactivate, open, close, disposeProject };
};
