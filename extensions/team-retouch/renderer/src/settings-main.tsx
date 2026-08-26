/* eslint-disable react-refresh/only-export-components -- packaged settings entry defines and mounts its isolated root */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LegacyDialogProvider } from './legacy/legacy-dialog';
import { notify, rpc, type ComponentContext } from './sdk';
import { TeamSettingsContent } from './team-settings-content';
import { createTeamSettingsController, type TeamSettingsState } from './team-settings-model';
import './host-api-ui.css';
import './tailwind.css';
import './settings-style.css';

type Json = Record<string, any>;
const applyResolvedTheme = (resolvedTheme: 'light' | 'dark') => {
  document.body.classList.add('pf-canvas');
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
  return <main className="team-settings-page" data-settings-contract="host-v1"><div className="team-settings-container"><h1 className="team-settings-title">团片协作</h1>{settingsState.settings && settingsState.loaded ? <TeamSettingsContent value={settingsState.settings} patch={controller.patch} notice={notify}/> : <section className="team-settings-card team-settings-loading" aria-live="polite"><p className="team-settings-row-title">{settingsState.loading ? '正在读取团片设置…' : '无法读取团片设置'}</p>{settingsState.error && <p role="alert" className="team-settings-error">请稍后重试；基础人物检测不受影响。</p>}{!settingsState.loading && <button type="button" className="team-settings-button team-settings-button-secondary" onClick={() => void controller.refresh()}>重新读取</button>}</section>}</div></main>;
};

createRoot(document.getElementById('app')!).render(<StrictMode><LegacyDialogProvider><SettingsRoot/></LegacyDialogProvider></StrictMode>);
