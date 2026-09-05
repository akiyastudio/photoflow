/* eslint-disable react-refresh/only-export-components -- packaged renderer entry defines and mounts its private root components */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, Settings, X } from 'lucide-react';
import { TeamRetouchManager } from './legacy/TeamRetouchManager';
import { PersonIdentityManager } from './legacy/PersonIdentityManager';
import { TeamRetouchBrand } from './legacy/TeamRetouchBrand';
import { LegacyDialogProvider } from './legacy/legacy-dialog';
import type { TeamRetouchStep } from './legacy/TeamRetouchSteps';
import { notify, rpc, type ComponentContext } from './sdk';
import { hydrateLegacyWorkspace, legacyApi, teamProjectRpc } from './legacy/legacy-api';
import type { TeamIdentityWorkspace } from './legacy/legacy-types';
import { resolveTeamRetouchEntriesForOpen } from './legacy/legacy-entry-scope';
import { createActivationRefreshGate, createHistoryContextLoadCoordinator, createLatestHistoryLoadGuard, historyLoadPresentation } from './legacy/legacy-history-load-model';
import { workspaceSeedScopeKey } from './legacy/legacy-workspace-seed-model';
import { canEnterWorkflowStage, latestWorkflowStage, normalizeWorkspace, workflowStageSummaries, type WorkflowStage } from './interaction-model';
import { TeamSettingsContent } from './team-settings-content';
import { createTeamSettingsController, type TeamSettingsState } from './team-settings-model';
import { historyToastTransition, type HistoryToastSnapshot } from './history-toast-model';
import './host-api-ui.css';
import './tailwind.css';
import './legacy-style.css';

type Json = Record<string, any>;
const assertSuccess = (value: Json, fallback: string) => { if (value?.success === false) throw new Error(value.error || fallback); return value; };
const applyResolvedTheme = (resolvedTheme: 'light' | 'dark') => {
  // This renderer owns its isolated document. Scoping the body keeps every
  // createPortal surface on the same contract without leaking into Host DOM.
  document.body.classList.add('legacy-root', 'pf-canvas');
  document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
  document.documentElement.style.colorScheme = resolvedTheme;
};

const TeamHistoryLoadSurface = ({ initialLoading, loadError, entriesLoaded, entryCount, retry, openSettings }: { initialLoading: boolean; loadError: string; entriesLoaded: boolean; entryCount: number; retry: () => void; openSettings: () => void }) => {
  const presentation = historyLoadPresentation({ initialLoading, loadError, entriesLoaded, entryCount });
  return <div className="team-shell pf-canvas fixed inset-x-0 bottom-0 top-0 z-[310] flex flex-col">
    <header className="team-toolbar pf-toolbar flex min-h-14 items-center gap-3 px-4 py-2"><TeamRetouchBrand/><div><h2 className="text-sm font-bold text-slate-900">{presentation.title.replace(/^团片协作 · /, '')}</h2><p className="mt-0.5 text-xs text-slate-500">恢复已登记历史，再合并本次明确选择的图片。</p></div><button type="button" onClick={openSettings} title="团片协作设置" className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100"><Settings size={18}/></button></header>
    <main className="flex min-h-0 flex-1 items-center justify-center p-6">{presentation.phase === 'loading' ? <div role="status" aria-live="polite" className="team-card pf-card flex min-h-52 w-full max-w-3xl items-center justify-center text-sm font-bold text-slate-600"><Loader2 size={18} className="mr-2 animate-spin text-blue-600"/>正在读取团片历史…</div> : <div role="alert" className="team-card pf-card flex min-h-52 w-full max-w-3xl flex-col items-center justify-center gap-3 px-6 text-center"><AlertTriangle size={24} className="text-red-600"/><p className="font-bold text-red-700">团片历史读取失败</p><p className="max-w-2xl text-xs leading-5 text-slate-500">{loadError || '暂时无法读取团片历史，请重试。'}</p><button type="button" className="pf-button-primary dialog-primary" onClick={retry}>重新读取团片历史</button></div>}</main>
  </div>;
};

const TeamSettingsDialog = ({ state, patch, retry, close, notice }: { state: TeamSettingsState; patch: ReturnType<typeof createTeamSettingsController>['patch']; retry: () => void; close: () => void; notice: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void }) => {
  return createPortal(<div className="pf-modal-backdrop fixed inset-0 z-[850] flex items-center justify-center p-4"><section role="dialog" aria-modal="true" aria-label="团片协作设置" className="team-modal pf-modal flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden"><header className="team-toolbar pf-toolbar flex min-h-14 items-center gap-3 px-5"><span className="pf-icon-tile p-2"><Settings size={18}/></span><div><h2 className="text-sm font-bold text-slate-900">团片协作设置</h2><p className="mt-0.5 text-[11px] text-slate-500">处理偏好与团片协作专属识别环境</p></div><button className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100" onClick={close} aria-label="关闭设置"><X size={18}/></button></header><div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-slate-50 p-5">
    {state.settings && state.loaded ? <TeamSettingsContent value={state.settings} patch={patch} notice={notice}/> : <div className="team-card pf-card flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center"><Loader2 size={18} className={state.loading ? 'animate-spin text-blue-600' : 'text-slate-400'}/><p className="text-sm font-bold text-slate-700">{state.loading ? '正在读取团片设置…' : '无法读取团片设置'}</p>{state.error && <p role="alert" className="text-xs text-red-600">{state.error}</p>}{!state.loading && <button type="button" className="dialog-secondary" onClick={retry}>重试</button>}</div>}
  </div></section></div>, document.body);
};

const App = () => {
  const [context, setContext] = useState<ComponentContext>(); const [entries, setEntries] = useState<Json[]>([]); const [step, setStep] = useState<TeamRetouchStep>('detect'); const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsState, setSettingsState] = useState<TeamSettingsState>({ loaded: false, loading: false, error: '' });
  const settingsControllerRef = useRef<ReturnType<typeof createTeamSettingsController>>();
  if (!settingsControllerRef.current) settingsControllerRef.current = createTeamSettingsController({ read: () => rpc<Json>('team.settings.get.v1'), merge: patch => rpc<Json>('team.settings.update.v1', patch), notice: notify });
  const settingsController = settingsControllerRef.current;
  const [componentActive, setComponentActive] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true); const [loadError, setLoadError] = useState(''); const [entriesLoaded, setEntriesLoaded] = useState(false);
  const [historyPathWarning, setHistoryPathWarning] = useState('');
  const [historyLoadInFlight, setHistoryLoadInFlight] = useState(false);
  const [historyRecordCount, setHistoryRecordCount] = useState(0); const [historyOwnershipPendingCount, setHistoryOwnershipPendingCount] = useState(0);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<Json>(() => normalizeWorkspace(undefined));
  const [managerWorkspaceSeed, setManagerWorkspaceSeed] = useState<{ scopeKey: string; workspace: TeamIdentityWorkspace }>();
  const [managerWorkspaceLoadingScopeKey, setManagerWorkspaceLoadingScopeKey] = useState('');
  const [operationBusy, setOperationBusy] = useState(false);
  const contextRef = useRef<ComponentContext>();
  const entriesRef = useRef<Json[]>([]);
  const entriesLoadedRef = useRef(false);
  const loadGuardRef = useRef(createLatestHistoryLoadGuard());
  const loadCoordinatorRef = useRef<ReturnType<typeof createHistoryContextLoadCoordinator<ComponentContext>> | null>(null);
  const activationRefreshGateRef = useRef(createActivationRefreshGate());
  const reconcileStartedRef = useRef('');
  const latestStageProjectRef = useRef('');
  const historyWarningToastRef = useRef<HistoryToastSnapshot>();
  const loadToastRef = useRef<HistoryToastSnapshot>();
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  useEffect(() => {
    if (!entriesLoaded) return;
    const transition = historyToastTransition({ previous: historyWarningToastRef.current, currentMessage: historyPathWarning, currentTone: 'warning', inFlight: historyLoadInFlight, recoveredMessage: '团片历史已恢复', dedupeKey: 'team-retouch:history-warning' });
    historyWarningToastRef.current = transition.next;
    if (transition.notice) notify(transition.notice.message, transition.notice.tone, { dedupeKey: transition.notice.dedupeKey });
  }, [entriesLoaded, historyLoadInFlight, historyPathWarning]);
  useEffect(() => {
    if (!entriesLoaded) return;
    const transition = historyToastTransition({ previous: loadToastRef.current, currentMessage: loadError, currentTone: 'error', inFlight: historyLoadInFlight, recoveredMessage: '团片历史已恢复', dedupeKey: 'team-retouch:history-load' });
    loadToastRef.current = transition.next;
    if (transition.notice) notify(transition.notice.message, transition.notice.tone, { dedupeKey: transition.notice.dedupeKey });
  }, [entriesLoaded, historyLoadInFlight, loadError]);
  const performLoadEntries = useCallback(async (hostContext: ComponentContext) => {
    setHistoryLoadInFlight(true);
    const managerScopeKey = workspaceSeedScopeKey(hostContext.projectId, { id: hostContext.projectId, name: hostContext.projectName, status: hostContext.projectStatus });
    setManagerWorkspaceLoadingScopeKey(managerScopeKey);
    const requestId = loadGuardRef.current.begin();
    if (!entriesLoadedRef.current) setInitialLoading(true);
    setLoadError(''); setHistoryPathWarning('');
    try {
      let workspace = assertSuccess(await teamProjectRpc<Json>('team.project.get.v1'), '无法读取团片协作历史');
      if (!loadGuardRef.current.isCurrent(requestId)) return;
      if (workspace.recoveryRequired?.required) {
        notify('检测到恢复后的协作输出，正在当前项目内受控校准；完成前不会开放编辑', 'info');
        const reconciliation = await legacyApi.drainTeamWorkflowReconciles({ maxItems: 20 });
        if (!loadGuardRef.current.isCurrent(requestId)) return;
        if (reconciliation.success === false || reconciliation.state === 'failed') throw new Error(reconciliation.error || '恢复后的协作输出尚未校准，已阻止使用旧状态');
        workspace = assertSuccess(await teamProjectRpc<Json>('team.project.get.v1'), '无法刷新恢复后的团片协作历史');
        if (workspace.recoveryRequired?.required) throw new Error('恢复后的协作输出仍需校准，已阻止使用旧状态');
      }
      const selectedRelativePaths = hostContext.selectedRelativePaths || [];
      if (selectedRelativePaths.length) {
        workspace = assertSuccess(await teamProjectRpc<Json>('team.project.register.v1', { relativePaths: selectedRelativePaths }), '无法登记所选团片图片');
        if (!loadGuardRef.current.isCurrent(requestId)) return;
      }
      setWorkspaceSnapshot(normalizeWorkspace(workspace));
      const knownPaths = entriesRef.current.filter(entry => !entry.teamHistoryMissing).map(entry => String(entry.relativePath || '')).filter(Boolean);
      const resolution = resolveTeamRetouchEntriesForOpen(workspace, [...knownPaths, ...selectedRelativePaths]);
      setHistoryRecordCount(resolution.historyPhotoCount); setHistoryOwnershipPendingCount(resolution.ownershipPendingCount);
      const warnings = [];
      if (resolution.ownershipPendingCount) warnings.push(`${resolution.ownershipPendingCount} 条当前记录尚未取得项目归属`);
      if (resolution.missingHistoryCount) warnings.push(`${resolution.missingHistoryCount} 张图片缺少可用路径，已保留为“缺失 / 需重新关联”卡片`);
      setHistoryPathWarning(warnings.join('；'));
      legacyApi.setProjectEntries(resolution.entries); entriesRef.current = resolution.entries; setEntries(resolution.entries);
      setManagerWorkspaceSeed({ scopeKey: managerScopeKey, workspace: hydrateLegacyWorkspace(workspace) });
      entriesLoadedRef.current = true; setEntriesLoaded(true); setInitialLoading(false);
    } catch (error) {
      if (!loadGuardRef.current.isCurrent(requestId)) return;
      setInitialLoading(false); setLoadError(error instanceof Error ? error.message : String(error));
    } finally { setManagerWorkspaceLoadingScopeKey(current => current === managerScopeKey ? '' : current); setHistoryLoadInFlight(false); }
  }, []);
  if (!loadCoordinatorRef.current) loadCoordinatorRef.current = createHistoryContextLoadCoordinator(performLoadEntries);
  const loadEntries = useCallback((hostContext: ComponentContext, options: { force?: boolean } = {}) => loadCoordinatorRef.current!.request(hostContext, options), []);
  useEffect(() => {
    if (!entriesLoaded || !context?.projectId || reconcileStartedRef.current === context.projectId) return;
    reconcileStartedRef.current = context.projectId;
    void legacyApi.drainTeamWorkflowReconciles({ maxItems: 4 }).then((result: Json) => {
      if (result.recoveredCount && contextRef.current) void loadEntries(contextRef.current, { force: true });
    }).catch(() => undefined);
  }, [entriesLoaded, context?.projectId, loadEntries]);
  useEffect(() => {
    let mounted = true;
    const stopSettings = settingsController.subscribe(value => { if (mounted) setSettingsState(value); });
    const acceptContext = (nextContext: ComponentContext) => {
      if (!mounted) return;
      const projectChanged = Boolean(contextRef.current?.projectId && contextRef.current.projectId !== nextContext.projectId);
      if (projectChanged) {
        loadGuardRef.current.invalidate();
        entriesRef.current = []; setEntries([]); entriesLoadedRef.current = false; setEntriesLoaded(false);
        setWorkspaceSnapshot(normalizeWorkspace(undefined)); setManagerWorkspaceSeed(undefined);
        reconcileStartedRef.current = ''; latestStageProjectRef.current = ''; setStep('detect');
      }
      legacyApi.setMediaAuthorizationScope(nextContext.projectId);
      contextRef.current = nextContext; setContext(nextContext); applyResolvedTheme(nextContext.resolvedTheme);
      void loadEntries(nextContext);
    };
    void window.photoFlowComponent.getContext().then(acceptContext).catch(error => { if (mounted) { setInitialLoading(false); setLoadError(error instanceof Error ? error.message : String(error)); } });
    void settingsController.refresh();
    const stopTheme = window.photoFlowComponent.onThemeChange(value => { if (mounted && value.contractVersion === 1) applyResolvedTheme(value.resolvedTheme); });
    const stopContext = window.photoFlowComponent.onContextChange(acceptContext);
    const stopActivate = window.photoFlowComponent.onActivate(() => { if (mounted) { setComponentActive(true); void settingsController.refresh(); if (activationRefreshGateRef.current.activate() && !loadCoordinatorRef.current?.isLoading() && contextRef.current) void loadEntries(contextRef.current, { force: true }); } });
    const stopDeactivate = window.photoFlowComponent.onDeactivate(() => { if (mounted) { activationRefreshGateRef.current.deactivate(); setComponentActive(false); } });
    return () => { mounted = false; settingsController.invalidate(); loadGuardRef.current.invalidate(); stopSettings(); stopTheme(); stopContext(); stopActivate(); stopDeactivate(); };
  }, [loadEntries, settingsController]);
  useEffect(() => {
    const projectId = String(context?.projectId || '');
    if (!projectId || !entriesLoaded || latestStageProjectRef.current === projectId) return;
    latestStageProjectRef.current = projectId;
    setStep(latestWorkflowStage(workspaceSnapshot));
  }, [context?.projectId, entriesLoaded, workspaceSnapshot]);
  const project = { id: context?.projectId || '', name: context?.projectName || '', status: context?.projectStatus || '', path: '' };
  const currentManagerScopeKey = workspaceSeedScopeKey(context?.projectId || '', project);
  const stageSummaries = workflowStageSummaries(workspaceSnapshot, step);
  const changeStep = (next: WorkflowStage) => {
    if (operationBusy) { notify('当前操作正在处理，请完成后再切换步骤', 'warning'); return; }
    const guard = canEnterWorkflowStage(workspaceSnapshot, next);
    if (!guard.allowed) { notify(guard.reason, 'warning'); return; }
    setStep(next);
  };
  const openSettings = () => { setSettingsOpen(true); void settingsController.refresh(); };
  const common = { workspacePath: context?.projectId || '', project, initialWorkspace: managerWorkspaceSeed?.scopeKey === currentManagerScopeKey ? managerWorkspaceSeed.workspace : undefined, initialWorkspacePending: managerWorkspaceLoadingScopeKey === currentManagerScopeKey, cacheConfig: { directory: '', maxSizeGB: 0 }, componentActive, activeStep: step, onStepChange: changeStep, stageSummaries, onBlockedStage: (reason: string) => notify(reason, 'warning'), onClose: () => undefined, onOpenSettings: openSettings, onNotice: notify, onBusyChange: setOperationBusy, onProjectChanged: () => { if (contextRef.current) void loadEntries(contextRef.current, { force: true }); } };
  const retryHistory = () => {
    if (contextRef.current) { void loadEntries(contextRef.current, { force: true }); return; }
    setInitialLoading(true); setLoadError('');
    void window.photoFlowComponent.getContext().then(nextContext => { contextRef.current = nextContext; setContext(nextContext); applyResolvedTheme(nextContext.resolvedTheme); void loadEntries(nextContext); }).catch(error => { setInitialLoading(false); setLoadError(error instanceof Error ? error.message : String(error)); });
  };
  return <LegacyDialogProvider><div className="legacy-root pf-canvas">
    {!entriesLoaded ? <TeamHistoryLoadSurface initialLoading={initialLoading} loadError={loadError} entriesLoaded={entriesLoaded} entryCount={entries.length} retry={retryHistory} openSettings={common.onOpenSettings}/> : step !== 'detect' ? <PersonIdentityManager {...common} onClose={common.onOpenSettings} activeStep={step} historyIssue={loadError || historyPathWarning} onRetryHistory={retryHistory}/> : <TeamRetouchManager {...common} historyRecordCount={historyRecordCount} historyOwnershipPendingCount={historyOwnershipPendingCount} entries={entries as any} onEntriesChange={value => setEntries(value)} historyIssue={loadError || historyPathWarning} onRetryHistory={retryHistory}/>}
    {settingsOpen && <TeamSettingsDialog state={settingsState} patch={settingsController.patch} retry={() => void settingsController.refresh()} close={() => setSettingsOpen(false)} notice={notify}/>}
  </div></LegacyDialogProvider>;
};
createRoot(document.getElementById('app')!).render(<App/>);
