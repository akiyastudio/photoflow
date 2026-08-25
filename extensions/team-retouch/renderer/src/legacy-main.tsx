/* eslint-disable react-refresh/only-export-components -- packaged renderer entry defines and mounts its private root components */
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, Settings, UsersRound, X } from 'lucide-react';
import { TeamRetouchManager } from './legacy/TeamRetouchManager';
import { PersonIdentityManager } from './legacy/PersonIdentityManager';
import { LegacyDialogProvider } from './legacy/legacy-dialog';
import type { TeamRetouchStep } from './legacy/TeamRetouchSteps';
import { notify, rpc, type ComponentContext } from './sdk';
import { hydrateLegacyWorkspace, legacyApi } from './legacy/legacy-api';
import type { TeamIdentityWorkspace } from './legacy/legacy-types';
import { resolveTeamRetouchEntriesForOpen } from './legacy/legacy-entry-scope';
import { createActivationRefreshGate, createHistoryContextLoadCoordinator, createLatestHistoryLoadGuard, historyLoadPresentation, historyMigrationDelayMs } from './legacy/legacy-history-load-model';
import { legacyMigrationActivityLabel, legacyMigrationErrorMessage, legacyMigrationPausedMessage, legacyMigrationRunningMessage, nextLegacyMigrationNoProgressCount } from './legacy/legacy-migration-progress-model';
import { workspaceSeedScopeKey } from './legacy/legacy-workspace-seed-model';
import { canEnterWorkflowStage, normalizeWorkspace, workflowStageSummaries, type WorkflowStage } from './interaction-model';
import { TeamSettingsContent } from './team-settings-content';
import { createTeamSettingsController, type TeamSettingsState } from './team-settings-model';
import './host-api-ui.css';
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
    <header className="team-toolbar pf-toolbar flex min-h-16 items-center gap-3 px-5 py-3"><span className="team-icon-tile pf-icon-tile p-2"><UsersRound size={20}/></span><div><h2 className="font-bold text-slate-900">{presentation.title}</h2><p className="mt-0.5 text-xs text-slate-500">恢复已登记历史，再合并本次明确选择的图片。</p></div><button type="button" onClick={openSettings} title="团片协作设置" className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100"><Settings size={20}/></button></header>
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
  const [migrationPaused, setMigrationPaused] = useState(false);
  const [historyRecordCount, setHistoryRecordCount] = useState(0); const [historyOwnershipPendingCount, setHistoryOwnershipPendingCount] = useState(0);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<Json>(() => normalizeWorkspace(undefined));
  const [managerWorkspaceSeed, setManagerWorkspaceSeed] = useState<{ scopeKey: string; workspace: TeamIdentityWorkspace }>();
  const [managerWorkspaceLoadingScopeKey, setManagerWorkspaceLoadingScopeKey] = useState('');
  const contextRef = useRef<ComponentContext>();
  const entriesRef = useRef<Json[]>([]);
  const entriesLoadedRef = useRef(false);
  const loadGuardRef = useRef(createLatestHistoryLoadGuard());
  const loadCoordinatorRef = useRef<ReturnType<typeof createHistoryContextLoadCoordinator<ComponentContext>> | null>(null);
  const activationRefreshGateRef = useRef(createActivationRefreshGate());
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  const performLoadEntries = useCallback(async (hostContext: ComponentContext, manualMigrationRetry = false) => {
    const managerScopeKey = workspaceSeedScopeKey(hostContext.projectId, { id: hostContext.projectId, name: hostContext.projectName, status: hostContext.projectStatus });
    setManagerWorkspaceLoadingScopeKey(managerScopeKey);
    const requestId = loadGuardRef.current.begin();
    if (!entriesLoadedRef.current) setInitialLoading(true);
    setLoadError(''); setHistoryPathWarning(''); setMigrationPaused(false);
    const selectedRelativePaths = hostContext.selectedRelativePaths || [];
    try {
      let workspace = assertSuccess(await rpc<Json>('team.project.get.v1'), '无法读取团片协作历史');
      if (!loadGuardRef.current.isCurrent(requestId)) return;
      setWorkspaceSnapshot(normalizeWorkspace(workspace));
      const waitingForHostStorage = workspace.migration?.phase === 'host-storage-adoption';
      if (workspace.migration?.state !== 'committed') {
        const advanceMigration = async () => {
          let migration = workspace.migration;
          let noProgressCount = 0;
          let storageWaitCount = 0;
          while (loadGuardRef.current.isCurrent(requestId) && migration?.state !== 'committed') {
            if (migration?.lastError && !manualMigrationRetry) {
              setMigrationPaused(true); setHistoryPathWarning(legacyMigrationErrorMessage(migration, String(migration.lastError))); return;
            }
            setHistoryPathWarning(migration?.phase === 'host-storage-adoption'
              ? '团片历史正在完成首次安全迁移，完成后会自动恢复，期间不会写入；请保持应用运行。'
              : legacyMigrationRunningMessage(migration));
            const delayMs = historyMigrationDelayMs(String(migration?.phase || ''), storageWaitCount);
            await new Promise(resolve => window.setTimeout(resolve, delayMs));
            const previousMigration = migration;
            migration = await rpc<Json>('team.project.migrate-step.v1');
            manualMigrationRetry = false;
            if (migration?.lastError) { setMigrationPaused(true); setHistoryPathWarning(legacyMigrationErrorMessage(migration, String(migration.lastError))); return; }
            noProgressCount = nextLegacyMigrationNoProgressCount(previousMigration, migration, noProgressCount);
            storageWaitCount = migration?.phase === 'host-storage-adoption' ? storageWaitCount + 1 : 0;
            if (migration?.phase !== 'host-storage-adoption' && noProgressCount >= 3) {
              setMigrationPaused(true); setHistoryPathWarning(legacyMigrationPausedMessage(migration)); return;
            }
          }
          if (loadGuardRef.current.isCurrent(requestId) && migration?.state === 'committed') {
            let refreshed = assertSuccess(await rpc<Json>('team.project.get.v1'), '无法刷新团片协作历史');
            if (!loadGuardRef.current.isCurrent(requestId)) return;
            if (waitingForHostStorage && selectedRelativePaths.length) refreshed = assertSuccess(await rpc<Json>('team.project.register.v1', { relativePaths: selectedRelativePaths }), '无法登记所选团片图片');
            if (!loadGuardRef.current.isCurrent(requestId)) return;
            setWorkspaceSnapshot(normalizeWorkspace(refreshed));
            const refreshedResolution = resolveTeamRetouchEntriesForOpen(refreshed, entriesRef.current.map(entry => String(entry.relativePath || '')).filter(Boolean));
            legacyApi.setProjectEntries(refreshedResolution.entries); entriesRef.current = refreshedResolution.entries; setEntries(refreshedResolution.entries);
            setManagerWorkspaceSeed({ scopeKey: managerScopeKey, workspace: hydrateLegacyWorkspace(refreshed) });
            setHistoryRecordCount(refreshedResolution.historyPhotoCount); setHistoryOwnershipPendingCount(refreshedResolution.ownershipPendingCount);
            entriesLoadedRef.current = true; setEntriesLoaded(true); setInitialLoading(false);
            setHistoryPathWarning('团片迁移与工作流程目录恢复完成。');
          }
        };
        await advanceMigration().catch(error => {
          if (!loadGuardRef.current.isCurrent(requestId)) return;
          const message = `${legacyMigrationActivityLabel(workspace.migration)}已暂停：${error instanceof Error ? error.message : String(error)}`;
          if (waitingForHostStorage) { setInitialLoading(false); setLoadError(message); }
          else setHistoryPathWarning(message);
        });
      }
      if (waitingForHostStorage) return;
      const currentRelativePaths = entriesRef.current.filter(entry => !entry.teamHistoryMissing).map(entry => String(entry.relativePath || '')).filter(Boolean);
      const historyResolution = resolveTeamRetouchEntriesForOpen(workspace, currentRelativePaths);
      setHistoryRecordCount(historyResolution.historyPhotoCount); setHistoryOwnershipPendingCount(historyResolution.ownershipPendingCount);
      if (historyResolution.historyPhotoCount > 0 && historyResolution.resolvedHistoryCount === 0) {
        entriesRef.current = historyResolution.entries; setEntries(historyResolution.entries); setInitialLoading(false);
        setLoadError(`团片历史路径恢复失败（Host 已找到 ${historyResolution.returnedPhotoCount}/${historyResolution.historyPhotoCount} 张，${historyResolution.ownershipPendingCount} 条历史归属待恢复；已读到 ${historyResolution.historyTaskCount} 个工作图任务），暂时无法关联项目文件。`);
        return;
      }
      const historyEntries = historyResolution.entries;
      const historyWarnings = [];
      if (historyResolution.ownershipPendingCount) historyWarnings.push(`已找到 ${historyResolution.returnedPhotoCount}/${historyResolution.historyPhotoCount} 张，${historyResolution.ownershipPendingCount} 条历史归属待恢复`);
      if (historyResolution.missingHistoryCount) historyWarnings.push(`${historyResolution.missingHistoryCount} 张图片缺少可用路径，已保留为“缺失 / 需重新关联”卡片`);
      if (historyWarnings.length) setHistoryPathWarning(historyWarnings.join('；'));
      legacyApi.setProjectEntries(historyEntries); entriesRef.current = historyEntries; setEntries(historyEntries);
      if (selectedRelativePaths.length) {
        try {
          const registered = assertSuccess(await rpc<Json>('team.project.register.v1', { relativePaths: selectedRelativePaths }), '无法登记所选团片图片');
          if (!loadGuardRef.current.isCurrent(requestId)) return;
          if (registered.photos) workspace = registered;
          setWorkspaceSnapshot(normalizeWorkspace(workspace));
          const nextResolution = resolveTeamRetouchEntriesForOpen(workspace, [...currentRelativePaths, ...selectedRelativePaths]);
          setHistoryRecordCount(nextResolution.historyPhotoCount); setHistoryOwnershipPendingCount(nextResolution.ownershipPendingCount);
          const nextWarnings = [];
          if (nextResolution.ownershipPendingCount) nextWarnings.push(`已找到 ${nextResolution.returnedPhotoCount}/${nextResolution.historyPhotoCount} 张，${nextResolution.ownershipPendingCount} 条历史归属待恢复`);
          if (nextResolution.missingHistoryCount) nextWarnings.push(`${nextResolution.missingHistoryCount} 张图片缺少可用路径，已保留为“缺失 / 需重新关联”卡片`);
          setHistoryPathWarning(nextWarnings.join('；'));
          legacyApi.setProjectEntries(nextResolution.entries); entriesRef.current = nextResolution.entries; setEntries(nextResolution.entries);
        } catch (error) {
          if (!loadGuardRef.current.isCurrent(requestId)) return;
          const message = error instanceof Error ? error.message : String(error);
          setLoadError(`所选图片登记失败：${message}。已保留上次成功读取的团片历史。`);
        }
      }
      setManagerWorkspaceSeed({ scopeKey: managerScopeKey, workspace: hydrateLegacyWorkspace(workspace) });
      entriesLoadedRef.current = true; setEntriesLoaded(true); setInitialLoading(false);
    } catch (error) {
      if (!loadGuardRef.current.isCurrent(requestId)) return;
      setInitialLoading(false); setLoadError(error instanceof Error ? error.message : String(error));
    } finally { setManagerWorkspaceLoadingScopeKey(current => current === managerScopeKey ? '' : current); }
  }, []);
  if (!loadCoordinatorRef.current) loadCoordinatorRef.current = createHistoryContextLoadCoordinator(performLoadEntries);
  const loadEntries = useCallback((hostContext: ComponentContext, options: { force?: boolean; manualMigrationRetry?: boolean } = {}) => loadCoordinatorRef.current!.request(hostContext, options), []);
  useEffect(() => {
    let mounted = true;
    const stopSettings = settingsController.subscribe(value => { if (mounted) setSettingsState(value); });
    const acceptContext = (nextContext: ComponentContext) => { if (!mounted) return; contextRef.current = nextContext; setContext(nextContext); applyResolvedTheme(nextContext.resolvedTheme); void loadEntries(nextContext); };
    void window.photoFlowComponent.getContext().then(acceptContext).catch(error => { if (mounted) { setInitialLoading(false); setLoadError(error instanceof Error ? error.message : String(error)); } });
    void settingsController.refresh();
    const stopTheme = window.photoFlowComponent.onThemeChange(value => { if (mounted && value.contractVersion === 1) applyResolvedTheme(value.resolvedTheme); });
    const stopContext = window.photoFlowComponent.onContextChange(acceptContext);
    const stopActivate = window.photoFlowComponent.onActivate(() => { if (mounted) { setComponentActive(true); void settingsController.refresh(); if (activationRefreshGateRef.current.activate() && !loadCoordinatorRef.current?.isLoading() && contextRef.current) void loadEntries(contextRef.current, { force: true }); } });
    const stopDeactivate = window.photoFlowComponent.onDeactivate(() => { if (mounted) { activationRefreshGateRef.current.deactivate(); setComponentActive(false); } });
    return () => { mounted = false; settingsController.invalidate(); loadGuardRef.current.invalidate(); stopSettings(); stopTheme(); stopContext(); stopActivate(); stopDeactivate(); };
  }, [loadEntries, settingsController]);
  const project = { id: context?.projectId || '', name: context?.projectName || '', status: context?.projectStatus || '', path: '' };
  const currentManagerScopeKey = workspaceSeedScopeKey(context?.projectId || '', project);
  const stageSummaries = workflowStageSummaries(workspaceSnapshot, step);
  const changeStep = (next: WorkflowStage) => {
    const guard = canEnterWorkflowStage(workspaceSnapshot, next);
    if (!guard.allowed) { notify(guard.reason, 'warning'); return; }
    setStep(next);
  };
  const openSettings = () => { setSettingsOpen(true); void settingsController.refresh(); };
  const common = { workspacePath: context?.projectId || '', project, initialWorkspace: managerWorkspaceSeed?.scopeKey === currentManagerScopeKey ? managerWorkspaceSeed.workspace : undefined, initialWorkspacePending: managerWorkspaceLoadingScopeKey === currentManagerScopeKey, cacheConfig: { directory: '', maxSizeGB: 0 }, componentActive, activeStep: step, onStepChange: changeStep, stageSummaries, onBlockedStage: (reason: string) => notify(reason, 'warning'), onClose: () => undefined, onOpenSettings: openSettings, onNotice: notify, onProjectChanged: () => { if (contextRef.current) void loadEntries(contextRef.current, { force: true }); } };
  const retryHistory = () => {
    if (contextRef.current) { void loadEntries(contextRef.current, { force: true, manualMigrationRetry: true }); return; }
    setInitialLoading(true); setLoadError('');
    void window.photoFlowComponent.getContext().then(nextContext => { contextRef.current = nextContext; setContext(nextContext); applyResolvedTheme(nextContext.resolvedTheme); void loadEntries(nextContext); }).catch(error => { setInitialLoading(false); setLoadError(error instanceof Error ? error.message : String(error)); });
  };
  return <LegacyDialogProvider><div className="legacy-root pf-canvas">
    {!entriesLoaded ? <TeamHistoryLoadSurface initialLoading={initialLoading} loadError={loadError} entriesLoaded={entriesLoaded} entryCount={entries.length} retry={retryHistory} openSettings={common.onOpenSettings}/> : step !== 'detect' ? <PersonIdentityManager {...common} onClose={common.onOpenSettings} activeStep={step}/> : <TeamRetouchManager {...common} historyRecordCount={historyRecordCount} historyOwnershipPendingCount={historyOwnershipPendingCount} entries={entries as any} onEntriesChange={value => setEntries(value)} />}
    {historyPathWarning && entriesLoaded && <div role="status" aria-live="polite" className="pf-banner team-banner fixed left-1/2 top-20 z-[819] flex max-w-3xl -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-700 shadow-xl"><AlertTriangle size={16}/><span>{historyPathWarning}</span>{migrationPaused && <button type="button" className="rounded-md border border-amber-400 px-2 py-1" onClick={retryHistory}>重新尝试整理</button>}<button type="button" aria-label="关闭路径提示" onClick={() => setHistoryPathWarning('')}>×</button></div>}
    {loadError && entriesLoaded && <div role="alert" className="pf-banner team-banner fixed left-1/2 top-20 z-[820] flex max-w-3xl -translate-x-1/2 items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-xs font-bold text-red-700 shadow-xl"><AlertTriangle size={16}/><span>{loadError}</span><button type="button" className="rounded-md border border-red-300 px-2 py-1" onClick={retryHistory}>重试</button><button type="button" aria-label="关闭加载错误" onClick={() => setLoadError('')}>×</button></div>}
    {settingsOpen && <TeamSettingsDialog state={settingsState} patch={settingsController.patch} retry={() => void settingsController.refresh()} close={() => setSettingsOpen(false)} notice={notify}/>}
  </div></LegacyDialogProvider>;
};
createRoot(document.getElementById('app')!).render(<StrictMode><App/></StrictMode>);
