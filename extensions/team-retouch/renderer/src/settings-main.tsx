/* eslint-disable react-refresh/only-export-components -- packaged settings entry defines and mounts its isolated root */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Settings } from 'lucide-react';
import { LegacyDialogProvider } from './legacy/legacy-dialog';
import { notify, rpc, type ComponentContext } from './sdk';
import { TeamSettingsContent } from './team-settings-content';
import { createTeamSettingsController, type TeamSettingsState } from './team-settings-model';
import '../../../../component-sdk/ui.css';
import './legacy-style.css';

type Json = Record<string, any>;
const applyResolvedTheme = (resolvedTheme: 'light' | 'dark') => {
  document.body.classList.add('legacy-root', 'pf-canvas');
  document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
  document.documentElement.style.colorScheme = resolvedTheme;
};

const SettingsRoot = () => {
  const [settingsState, setSettingsState] = useState<TeamSettingsState>({ loaded: false, loading: true, error: '' });
  const controllerRef = useRef<ReturnType<typeof createTeamSettingsController>>();
  if (!controllerRef.current) controllerRef.current = createTeamSettingsController({ read: () => rpc<Json>('team.settings.get.v1'), merge: patch => rpc<Json>('team.settings.update.v1', patch), notice: notify });
  const controller = controllerRef.current;
  useEffect(() => {
    let mounted = true;
    const unsubscribe = controller.subscribe(value => { if (mounted) setSettingsState(value); });
    void window.photoFlowComponent.getContext().then((context: ComponentContext) => {
      if (!mounted) return;
      if (context.surface !== 'application.settings') throw new Error('设置页 surface 不匹配');
      applyResolvedTheme(context.resolvedTheme);
      return controller.refresh();
    }).catch(error => notify(`读取团片设置失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
    const offTheme = window.photoFlowComponent.onThemeChange(value => applyResolvedTheme(value.resolvedTheme));
    const offActivate = window.photoFlowComponent.onActivate(() => { if (mounted) void controller.refresh(); });
    return () => { mounted = false; controller.invalidate(); unsubscribe(); offTheme(); offActivate(); };
  }, [controller]);
  return <main className="min-h-screen bg-slate-50 px-8 py-10 lg:px-12"><div className="mx-auto w-full max-w-6xl"><header className="mb-8 flex items-center gap-3"><span className="pf-icon-tile p-2"><Settings size={20}/></span><div><h1 className="text-2xl font-bold text-slate-900">团片协作</h1><p className="mt-1 text-xs text-slate-500">处理偏好与团片协作专属识别环境</p></div></header>{settingsState.settings && settingsState.loaded ? <TeamSettingsContent value={settingsState.settings} patch={controller.patch} notice={notify}/> : <section className="team-card pf-card flex min-h-52 flex-col items-center justify-center gap-3 p-6 text-center"><p className="text-sm font-bold text-slate-700">{settingsState.loading ? '正在读取团片设置…' : '无法读取团片设置'}</p>{settingsState.error && <p role="alert" className="text-xs text-red-600">{settingsState.error}</p>}{!settingsState.loading && <button type="button" className="dialog-secondary" onClick={() => void controller.refresh()}>重试</button>}</section>}</div></main>;
};

createRoot(document.getElementById('app')!).render(<StrictMode><LegacyDialogProvider><SettingsRoot/></LegacyDialogProvider></StrictMode>);
