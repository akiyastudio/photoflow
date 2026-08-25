/* eslint-disable react-refresh/only-export-components -- packaged renderer entry defines and mounts its private root components */
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, RotateCcw, Settings, UsersRound, Wrench, X } from 'lucide-react';
import { TeamRetouchManager } from './legacy/TeamRetouchManager';
import { PersonIdentityManager } from './legacy/PersonIdentityManager';
import { LegacyDialogProvider } from './legacy/legacy-dialog';
import { useAppDialog } from './legacy/legacy-dialog-context';
import type { TeamRetouchStep } from './legacy/TeamRetouchSteps';
import { rpc, type ComponentContext } from './sdk';
import { hydrateLegacyWorkspace, legacyApi } from './legacy/legacy-api';
import type { TeamIdentityWorkspace } from './legacy/legacy-types';
import { resolveTeamRetouchEntriesForOpen } from './legacy/legacy-entry-scope';
import { createActivationRefreshGate, createHistoryContextLoadCoordinator, createLatestHistoryLoadGuard, historyLoadPresentation, historyMigrationDelayMs } from './legacy/legacy-history-load-model';
import { workspaceSeedScopeKey } from './legacy/legacy-workspace-seed-model';
import { canEnterWorkflowStage, normalizeWorkspace, workflowStageSummaries, type WorkflowStage } from './interaction-model';
import '../../../../component-sdk/ui.css';
import './legacy-style.css';

type Json = Record<string, any>;
type TeamSettings = { useGpu: boolean; oversizeCropMode: 'face-centered' | 'expand' };
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

const TeamSettingsDialog = ({ value, update, close, notice }: { value: TeamSettings; update: (value: TeamSettings) => void; close: () => void; notice: (message: string) => void }) => {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState(''); const [environment, setEnvironment] = useState<Json>();
  const run = async (label: string, action: () => Promise<void>) => { if (busy) return; setBusy(label); try { await action(); notice(`${label}完成`); } catch (error) { notice(error instanceof Error ? error.message : String(error)); } finally { setBusy(''); } };
  const save = (next: TeamSettings) => { update(next); void run('保存团片协作设置', async () => { assertSuccess(await rpc<Json>('team.settings.update.v1', next), '保存设置失败'); }); };
  return createPortal(<div className="pf-modal-backdrop fixed inset-0 z-[850] flex items-center justify-center p-4"><section role="dialog" aria-modal="true" aria-label="团片协作设置" className="team-modal pf-modal flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden"><header className="team-toolbar pf-toolbar flex min-h-14 items-center gap-3 px-5"><span className="pf-icon-tile p-2"><Settings size={18}/></span><div><h2 className="text-sm font-bold text-slate-900">团片协作设置</h2><p className="mt-0.5 text-[11px] text-slate-500">处理偏好与团片协作专属识别环境</p></div><button className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100" onClick={close} aria-label="关闭设置"><X size={18}/></button></header><div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-slate-50 p-5">
    <section className="team-card pf-card overflow-hidden"><h3 className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-slate-700">处理偏好</h3><div className="flex items-center justify-between gap-5 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">优先使用 GPU</h4><p className="mt-1 text-xs text-slate-500">显卡不支持或运行失败时，基础人物检测会自动回退 CPU。</p></div><button role="switch" aria-checked={value.useGpu} className={`relative h-6 w-11 rounded-full ${value.useGpu ? 'bg-blue-600' : 'bg-slate-300'}`} onClick={() => save({ ...value, useGpu: !value.useGpu })}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${value.useGpu ? 'left-6' : 'left-1'}`}/></button></div><div className="flex items-center justify-between gap-5 border-t border-slate-100 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">裁剪方式</h4><p className="mt-1 text-xs text-slate-500">人物超过 4000 像素时，可限制尺寸或保留完整人物；后者可能超出手机修图软件限制。</p></div><select className="form-input max-w-sm" value={value.oversizeCropMode} onChange={event => save({ ...value, oversizeCropMode: event.target.value as TeamSettings['oversizeCropMode'] })}><option value="face-centered">保持 4000 像素</option><option value="expand">扩大裁剪，保留完整人物</option></select></div></section>
    <section className="team-card pf-card overflow-hidden"><h3 className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-slate-700">识别引擎</h3><div className="flex items-start justify-between gap-5 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">基础人物检测</h4><p className="mt-1 text-xs text-slate-500">提供基础人物检测、裁图和分割。</p></div><p className="text-xs font-bold text-emerald-600">可用</p></div><div className="flex items-start justify-between gap-5 border-t border-slate-100 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">人物身份识别</h4><p className="mt-1 text-xs text-slate-500">用于跨照片识别同一人物。支持 CPU；可用显卡会自动加速。</p></div><p className="text-xs font-bold text-emerald-600">可用</p></div></section>
    <section className="team-card pf-card overflow-hidden"><h3 className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-slate-700">人物检测增强版</h3><div className="flex items-start justify-between gap-5 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">PairDETR + SAM 2.1</h4><p className="mt-1 text-xs text-slate-500">改善多人、遮挡和精细分割效果。</p>{environment && <pre className="mt-3 max-w-xl whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">{environment.message || environment.error || JSON.stringify(environment, null, 2)}</pre>}</div><div className="flex flex-wrap justify-end gap-2"><button className="dialog-secondary inline-flex items-center gap-2" onClick={() => void run('检查安装条件', async () => setEnvironment(await rpc<Json>('team.advanced.preflight.v1')))} disabled={Boolean(busy)}><RotateCcw size={14}/>检查</button><button className="dialog-primary inline-flex items-center gap-2" onClick={() => void run('安装或修复增强版', async () => setEnvironment(assertSuccess(await rpc<Json>('team.advanced.install.v1', { repair: true }), '安装失败')))} disabled={Boolean(busy)}><Wrench size={14}/>安装 / 修复</button><button className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50" onClick={() => void run('卸载增强版', async () => { if (!await appDialog.confirm({ title: '卸载人物检测增强版吗？', message: '将删除 PairDETR、SAM 2.1 和独立运行环境；基础检测和身份识别不受影响。', confirmLabel: '卸载增强版', tone: 'danger' })) return; assertSuccess(await rpc<Json>('team.advanced.uninstall.v1'), '卸载失败'); setEnvironment(undefined); })} disabled={Boolean(busy)}>卸载</button></div></div><div className="border-t border-slate-100 px-4 py-3.5"><h4 className="text-sm font-bold text-slate-800">安装条件</h4><p className="mt-1 text-xs leading-5 text-slate-500">Windows x64、WSL 2、支持 WSL CUDA 的 NVIDIA 显卡与驱动，以及至少 35 GB 可用空间。建议至少 8 GB 显存和 16 GB 系统内存。</p></div></section>
  </div></section></div>, document.body);
};

const App = () => {
  const [context, setContext] = useState<ComponentContext>(); const [entries, setEntries] = useState<Json[]>([]); const [step, setStep] = useState<TeamRetouchStep>('detect'); const [settings, setSettings] = useState<TeamSettings>({ useGpu: true, oversizeCropMode: 'face-centered' }); const [settingsOpen, setSettingsOpen] = useState(false); const [notice, setNotice] = useState('');
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
              setMigrationPaused(true); setHistoryPathWarning(`${migration.lastError}（剩余约 ${Number(migration.pendingCount) || 0} 项，历史可正常只读）`); return;
            }
            setHistoryPathWarning(migration?.phase === 'host-storage-adoption'
              ? '团片历史正在完成首次安全迁移，完成后会自动恢复，期间不会写入；请保持应用运行。'
              : `团片旧项目文件正在后台整理，剩余约 ${Number(migration?.pendingCount) || 0} 项；历史可正常只读。`);
            const delayMs = historyMigrationDelayMs(String(migration?.phase || ''), storageWaitCount);
            await new Promise(resolve => window.setTimeout(resolve, delayMs));
            const previousProcessed = Number(migration?.processedCount) || 0; const previousPending = Number(migration?.pendingCount) || 0;
            migration = await rpc<Json>('team.project.migrate-step.v1');
            manualMigrationRetry = false;
            if (migration?.lastError) { setMigrationPaused(true); setHistoryPathWarning(`${migration.lastError}（剩余约 ${Number(migration.pendingCount) || 0} 项，历史可正常只读）`); return; }
            const progressed = Number(migration?.processedCount) > previousProcessed || Number(migration?.pendingCount) < previousPending;
            noProgressCount = progressed ? 0 : noProgressCount + 1;
            storageWaitCount = migration?.phase === 'host-storage-adoption' ? storageWaitCount + 1 : 0;
            if (migration?.phase !== 'host-storage-adoption' && noProgressCount >= 3) {
              setMigrationPaused(true); setHistoryPathWarning(`团片旧项目文件整理暂无进展，已暂停自动重试（剩余约 ${Number(migration?.pendingCount) || 0} 项）；历史可正常只读。`); return;
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
            setHistoryPathWarning('团片旧项目文件整理完成。');
          }
        };
        await advanceMigration().catch(error => {
          if (!loadGuardRef.current.isCurrent(requestId)) return;
          const message = `团片旧项目文件整理已暂停：${error instanceof Error ? error.message : String(error)}`;
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
    const acceptContext = (nextContext: ComponentContext) => { if (!mounted) return; contextRef.current = nextContext; setContext(nextContext); applyResolvedTheme(nextContext.resolvedTheme); void loadEntries(nextContext); };
    void window.photoFlowComponent.getContext().then(acceptContext).catch(error => { if (mounted) { setInitialLoading(false); setLoadError(error instanceof Error ? error.message : String(error)); } });
    void rpc<Json>('team.settings.get.v1').then(saved => { if (mounted && saved.success !== false && saved.settings) setSettings(saved.settings as TeamSettings); }).catch(error => { if (mounted) setNotice(`读取团片设置失败：${error instanceof Error ? error.message : String(error)}`); });
    const stopTheme = window.photoFlowComponent.onThemeChange(value => { if (mounted && value.contractVersion === 1) applyResolvedTheme(value.resolvedTheme); });
    const stopContext = window.photoFlowComponent.onContextChange(acceptContext);
    const stopActivate = window.photoFlowComponent.onActivate(() => { if (mounted) { setComponentActive(true); if (activationRefreshGateRef.current.activate() && !loadCoordinatorRef.current?.isLoading() && contextRef.current) void loadEntries(contextRef.current, { force: true }); } });
    const stopDeactivate = window.photoFlowComponent.onDeactivate(() => { if (mounted) { activationRefreshGateRef.current.deactivate(); setComponentActive(false); } });
    return () => { mounted = false; loadGuardRef.current.invalidate(); stopTheme(); stopContext(); stopActivate(); stopDeactivate(); };
  }, [loadEntries]);
  const project = { id: context?.projectId || '', name: context?.projectName || '', status: context?.projectStatus || '', path: '' };
  const currentManagerScopeKey = workspaceSeedScopeKey(context?.projectId || '', project);
  const stageSummaries = workflowStageSummaries(workspaceSnapshot, step);
  const changeStep = (next: WorkflowStage) => {
    const guard = canEnterWorkflowStage(workspaceSnapshot, next);
    if (!guard.allowed) { setNotice(guard.reason); return; }
    setStep(next);
  };
  const common = { workspacePath: context?.projectId || '', project, initialWorkspace: managerWorkspaceSeed?.scopeKey === currentManagerScopeKey ? managerWorkspaceSeed.workspace : undefined, initialWorkspacePending: managerWorkspaceLoadingScopeKey === currentManagerScopeKey, cacheConfig: { directory: '', maxSizeGB: 0 }, componentActive, activeStep: step, onStepChange: changeStep, stageSummaries, onBlockedStage: setNotice, onClose: () => undefined, onOpenSettings: () => setSettingsOpen(true), onNotice: setNotice, onProjectChanged: () => { if (contextRef.current) void loadEntries(contextRef.current, { force: true }); } };
  const retryHistory = () => {
    if (contextRef.current) { void loadEntries(contextRef.current, { force: true, manualMigrationRetry: true }); return; }
    setInitialLoading(true); setLoadError('');
    void window.photoFlowComponent.getContext().then(nextContext => { contextRef.current = nextContext; setContext(nextContext); applyResolvedTheme(nextContext.resolvedTheme); void loadEntries(nextContext); }).catch(error => { setInitialLoading(false); setLoadError(error instanceof Error ? error.message : String(error)); });
  };
  return <LegacyDialogProvider><div className="legacy-root pf-canvas">
    {!entriesLoaded ? <TeamHistoryLoadSurface initialLoading={initialLoading} loadError={loadError} entriesLoaded={entriesLoaded} entryCount={entries.length} retry={retryHistory} openSettings={common.onOpenSettings}/> : step !== 'detect' ? <PersonIdentityManager {...common} onClose={common.onOpenSettings} activeStep={step}/> : <TeamRetouchManager {...common} historyRecordCount={historyRecordCount} historyOwnershipPendingCount={historyOwnershipPendingCount} entries={entries as any} onEntriesChange={value => setEntries(value)} />}
    {historyPathWarning && entriesLoaded && <div role="status" aria-live="polite" className="pf-banner team-banner fixed left-1/2 top-20 z-[819] flex max-w-3xl -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-700 shadow-xl"><AlertTriangle size={16}/><span>{historyPathWarning}</span>{migrationPaused && <button type="button" className="rounded-md border border-amber-400 px-2 py-1" onClick={retryHistory}>重新尝试整理</button>}<button type="button" aria-label="关闭路径提示" onClick={() => setHistoryPathWarning('')}>×</button></div>}
    {loadError && entriesLoaded && <div role="alert" className="pf-banner team-banner fixed left-1/2 top-20 z-[820] flex max-w-3xl -translate-x-1/2 items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-xs font-bold text-red-700 shadow-xl"><AlertTriangle size={16}/><span>{loadError}</span><button type="button" className="rounded-md border border-red-300 px-2 py-1" onClick={retryHistory}>重试</button><button type="button" aria-label="关闭加载错误" onClick={() => setLoadError('')}>×</button></div>}
    {notice && <div role="status" aria-live="polite" className="pf-banner team-banner fixed bottom-5 left-1/2 z-[820] flex max-w-2xl -translate-x-1/2 items-center gap-3 rounded-lg bg-slate-900 px-4 py-3 text-sm font-bold text-white shadow-xl"><UsersRound size={16}/><span>{notice}</span><button className="ml-2 text-slate-300" onClick={() => setNotice('')}>×</button></div>}
    {settingsOpen && <TeamSettingsDialog value={settings} update={setSettings} close={() => setSettingsOpen(false)} notice={setNotice}/>}
  </div></LegacyDialogProvider>;
};
createRoot(document.getElementById('app')!).render(<StrictMode><App/></StrictMode>);
