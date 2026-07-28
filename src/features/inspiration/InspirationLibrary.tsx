import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, Home, Lightbulb, Settings } from 'lucide-react';
import { ProjectWorkspace } from '../workspace/ProjectWorkspace';
import { ResearchView } from '../tools/ToolViews';
import type { AppConfig, ComponentStatus, WorkspaceProject } from '../../types';

export type InspirationSection = 'home' | 'browser';
export const INSPIRATION_PROJECT_NAME = '.__photoflow_inspiration__';

export const InspirationLibraryNavigator = ({
  rootPath,
  currentRelativePath,
  section,
  onOpenHome,
  onNavigate,
  onOpenSettings,
}: {
  rootPath: string;
  currentRelativePath: string;
  section: InspirationSection;
  onOpenHome: () => void;
  onNavigate: (relativePath: string) => void;
  onOpenSettings: () => void;
}) => {
  const segments = currentRelativePath.split(/[\\/]/).filter(Boolean);
  const crumbs = [{ label: '灵感库文件夹', path: '' }, ...segments.map((label, index) => ({
    label,
    path: segments.slice(0, index + 1).join('/'),
  }))];
  return <nav aria-label="灵感库导航" className="flex min-h-0 flex-1 flex-col border-r border-slate-200 bg-white">
    <div className="flex items-center gap-2 px-4 pb-3 pt-5 text-sm font-bold text-slate-800"><Lightbulb size={18} className="text-amber-500"/>灵感库</div>
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3">
      <button type="button" onClick={onOpenHome} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-bold ${section === 'home' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}><Home size={17}/>首页</button>
      <div className="my-2 border-t border-slate-200"/>
      {rootPath ? crumbs.map((crumb, index) => <button key={crumb.path || '__root__'} type="button" onClick={() => onNavigate(crumb.path)} title={crumb.label} className={`flex w-full min-w-0 items-center gap-2 rounded-lg py-2 pr-2 text-left text-sm ${section === 'browser' && index === crumbs.length - 1 ? 'bg-blue-50 font-bold text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`} style={{ paddingLeft: 12 + index * 14 }}><Folder size={16} className="shrink-0 text-blue-500"/><span className="truncate">{crumb.label}</span></button>) : <p className="px-3 py-4 text-xs leading-5 text-slate-400">请先在设置中选择灵感库文件夹。</p>}
    </div>
    <div className="border-t border-slate-200 p-3"><button type="button" onClick={onOpenSettings} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"><Settings size={17}/>设置</button></div>
  </nav>;
};

export const InspirationLibraryPage = ({
  active,
  section,
  navigationRequest,
  config,
  components,
  componentsLoading,
  onUpdateConfig,
  onDirectoryChange,
  onNotice,
}: {
  active: boolean;
  section: InspirationSection;
  navigationRequest?: { path: string; id: number };
  config: AppConfig;
  components: ComponentStatus[];
  componentsLoading: boolean;
  onUpdateConfig: (config: AppConfig) => void | boolean | Promise<void | boolean>;
  onDirectoryChange: (relativePath: string) => void;
  onNotice: (message: string, duration?: number) => void;
}) => {
  const rootPath = config.inspirationLibrary.rootPath.trim();
  const [choosingRoot, setChoosingRoot] = useState(false);
  const attemptedInitialChoiceRef = useRef(false);
  const chooseRoot = useCallback(async () => {
    if (choosingRoot) return;
    setChoosingRoot(true);
    try {
      const result = await window.electronAPI.chooseWorkspaceDirectory(rootPath);
      if (result.cancelled || !result.path) return;
      const nextConfig = { ...config, inspirationLibrary: { ...config.inspirationLibrary, rootPath: result.path } };
      const saved = await onUpdateConfig(nextConfig);
      if (saved === false) onNotice('保存灵感库文件夹失败，请重试。', 6000);
      else onDirectoryChange('');
    } finally {
      setChoosingRoot(false);
    }
  }, [choosingRoot, config, onDirectoryChange, onNotice, onUpdateConfig, rootPath]);
  useEffect(() => {
    if (!active || rootPath || attemptedInitialChoiceRef.current) return;
    attemptedInitialChoiceRef.current = true;
    void chooseRoot();
  }, [active, chooseRoot, rootPath]);

  if (!rootPath) {
    return <div className="flex h-full items-center justify-center p-8 text-center"><div><Folder size={42} className="mx-auto text-slate-300"/><h2 className="mt-4 text-xl font-bold text-slate-800">设置灵感库文件夹</h2><p className="mt-2 text-sm text-slate-500">首次使用灵感库，需要先选择用于收集和整理素材的文件夹。</p><button type="button" onClick={() => void chooseRoot()} disabled={choosingRoot} className="dialog-primary mt-5 disabled:opacity-50">{choosingRoot ? '正在选择…' : '选择灵感库文件夹'}</button></div></div>;
  }
  if (section === 'home') {
    return <div className="h-full overflow-auto p-8"><div className="mx-auto max-w-5xl"><ResearchView config={config.inspirationLibrary} onUpdateConfig={inspirationLibrary => onUpdateConfig({ ...config, inspirationLibrary })}/></div></div>;
  }
  const project: WorkspaceProject = {
    name: INSPIRATION_PROJECT_NAME,
    path: rootPath,
    status: '未分类',
    updatedAt: Date.now(),
  };
  const installedComponentIds = new Set(components.filter(component => component.installed).map(component => component.id));
  const teamRetouchStatus = components.find(component => component.id === 'team-retouch');
  const teamRetouchSettings = (config.componentSettings['team-retouch'] as AppConfig['personDetection'] | undefined) || config.personDetection;
  return <ProjectWorkspace
    active={active}
    activeView="project"
    browserMode="inspiration"
    browserTitle="灵感库"
    navigationRequest={navigationRequest}
    onDirectoryChange={onDirectoryChange}
    project={project}
    workspacePath={rootPath}
    installedComponentIds={installedComponentIds}
    componentsLoading={componentsLoading}
    teamRetouchStatus={teamRetouchStatus}
    teamRetouchSettings={teamRetouchSettings}
    initialPanel={null}
    importConfig={config.smartImport}
    brollConfig={config.brollImport}
    fileImportConfig={config.fileImport}
    conversionConfig={config.imageConversion}
    matchConfig={config.smartMatch}
    mediaCacheConfig={config.mediaCache}
    defaultFolderSort={config.defaultFolderSort}
    onOpenToolTab={() => undefined}
    onCloseToolTab={() => undefined}
    onToolTabBusyChange={() => undefined}
    onImportConfigChange={smartImport => onUpdateConfig({ ...config, smartImport })}
    onMatchConfigChange={smartMatch => onUpdateConfig({ ...config, smartMatch })}
    onMediaCacheConfigChange={mediaCache => onUpdateConfig({ ...config, mediaCache })}
    onNotice={onNotice}
    onProjectMoved={() => undefined}
    onDeleted={() => undefined}
  />;
};
