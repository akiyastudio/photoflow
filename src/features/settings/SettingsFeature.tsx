import React, { useState, useEffect } from 'react';
import { FolderOpen, HardDrive, Trash2, RotateCcw, Settings, Download, Puzzle, UsersRound, ScanSearch, Loader2, FileImage } from 'lucide-react';
import type { AppConfig, ComponentStatus } from '../../types';

const normalizeMediaCacheSize = (value: unknown, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};
export type SettingsSection = 'general' | 'storage' | 'components' | 'import' | 'team-retouch' | 'research-tools' | 'office-media-extractor';

const WorkspaceFolderPicker = ({ value, onChange }: { value: string; onChange: (path: string) => void }) => {
  const choose = async () => {
    const result = await window.electronAPI.chooseWorkspaceDirectory(value);
    if (!result.cancelled && result.path) onChange(result.path);
  };
  return <div className="flex gap-2"><div title={value || '需选择工作文件夹'} className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-700">{value || '需选择工作文件夹'}</div><button type="button" onClick={() => void choose()} className="dialog-secondary inline-flex shrink-0 items-center gap-2"><FolderOpen size={16}/>选择文件夹</button></div>;
};

const WorkspaceSetupPage = ({ config, onSave }: { config: AppConfig; onSave: (config: AppConfig) => void | Promise<void> }) => {
  const [workspacePath, setWorkspacePath] = useState(config.workspacePath);
  const confirm = async () => {
    const selectedPath = workspacePath.trim();
    if (selectedPath) await onSave({ ...config, workspacePath: selectedPath });
  };
  return <main className="fixed inset-x-0 bottom-0 top-10 z-40 flex items-center justify-center overflow-auto bg-slate-50 p-8"><section className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><FolderOpen size={28}/></div><div className="mt-5 text-center"><h1 className="text-2xl font-bold text-slate-900">选择工作文件夹</h1><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">请选择工作文件夹。选择磁盘根目录时，会在磁盘下创建“照片流”文件夹作为工作目录。</p></div><div className="mt-7"><WorkspaceFolderPicker value={workspacePath} onChange={setWorkspacePath}/></div><div className="mt-7 flex justify-end"><button type="button" onClick={() => void confirm()} disabled={!workspacePath.trim()} className="dialog-primary disabled:cursor-not-allowed disabled:opacity-45">开始使用</button></div></section></main>;
};

const formatComponentSize = (sizeBytes: number) => sizeBytes > 0 ? `${(sizeBytes / 1024 / 1024).toFixed(sizeBytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : '';

const LogSettings = ({ onNotice }: { onNotice: (message: string, duration?: number) => void }) => {
  const [clearing, setClearing] = useState(false);
  const openFolder = async () => {
    const result = await window.electronAPI.openLogsFolder();
    if (!result.success) onNotice(`打开日志文件夹失败：${result.error || '未知错误'}`, 5000);
  };
  const clear = async () => {
    if (clearing || !window.confirm('确定清空全部应用日志吗？此操作无法撤销。')) return;
    setClearing(true);
    try {
      const result = await window.electronAPI.clearLogs();
      if (!result.success) {
        onNotice(`清空日志失败：${result.error || '未知错误'}`, 5000);
        return;
      }
      onNotice(result.deletedCount ? `已清空 ${result.deletedCount} 个日志文件` : '没有需要清理的日志文件');
    } finally {
      setClearing(false);
    }
  };
  return <section>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h4 className="text-sm font-bold text-slate-800">应用日志</h4><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">日志用于排查运行异常，默认仅保留最近 7 天。清空操作只会删除照片流生成的日志文件。</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void openFolder()} className="dialog-secondary inline-flex items-center gap-2"><FolderOpen size={15}/>打开日志文件夹</button><button type="button" onClick={() => void clear()} disabled={clearing} className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-bold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50">{clearing ? <Loader2 size={15} className="animate-spin"/> : <Trash2 size={15}/>} {clearing ? '正在清空…' : '清空日志'}</button></div></div>
  </section>;
};

const ComponentSettings = ({ components, installPath, loading, onRefresh, onComponentsChanged, onNotice }: { components: ComponentStatus[]; installPath: string; loading: boolean; onRefresh: () => void | Promise<void>; onComponentsChanged: () => void | Promise<void>; onNotice: (message: string, duration?: number) => void }) => {
  const [busyId, setBusyId] = useState('');
  const openFolder = async () => {
    const result = await window.electronAPI.openComponentsFolder();
    if (!result.success) onNotice(`打开组件文件夹失败：${result.error || '未知错误'}`);
  };
  const install = async (component: ComponentStatus) => {
    if (busyId) return;
    setBusyId(component.id);
    try {
      const result = await window.electronAPI.installComponent(component.id);
      if (!result.success) { onNotice(`安装“${component.name}”失败：${result.error || '未知错误'}`, 5000); return; }
      if (result.cancelled) return;
      onNotice(`已安装“${component.name}”`);
      await onComponentsChanged();
    } finally { setBusyId(''); }
  };
  const uninstall = async (component: ComponentStatus) => {
    if (busyId || !window.confirm(`确定卸载“${component.name}”吗？组件文件夹会移入系统回收站。`)) return;
    setBusyId(component.id);
    try {
      const result = await window.electronAPI.uninstallComponent(component.id);
      if (!result.success) { onNotice(`卸载“${component.name}”失败：${result.error || '未知错误'}`, 5000); return; }
      onNotice(`已卸载“${component.name}”`);
      await onComponentsChanged();
    } finally { setBusyId(''); }
  };
  return <section>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-bold text-slate-800">组件安装与卸载</h4><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">在这里管理可选组件。安装时请选择已解压、包含 component.json 的组件文件夹。</p></div><div className="flex gap-2"><button type="button" onClick={() => void onRefresh()} disabled={loading} className="dialog-secondary inline-flex items-center gap-2"><RotateCcw size={15} className={loading ? 'animate-spin' : ''}/>刷新状态</button><button type="button" onClick={() => void openFolder()} className="dialog-secondary inline-flex items-center gap-2"><FolderOpen size={15}/>打开组件文件夹</button></div></div>
    {installPath && <div className="mt-3 break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">{installPath}</div>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">{components.map(component => {
      const stateText = !component.installed ? (component.compatible ? '未安装' : '不兼容') : component.source === 'development' ? '开发组件' : '已安装';
      const stateClass = component.installed ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : component.compatible ? 'text-slate-600 bg-slate-50 border-slate-200' : 'text-amber-700 bg-amber-50 border-amber-200';
      const busy = busyId === component.id;
      const canUninstall = component.installed && component.source === 'application';
      return <article key={component.id} className="flex flex-col rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><h5 className="text-sm font-bold text-slate-800">{component.name}</h5><p className="mt-1 text-xs leading-5 text-slate-500">{component.description}</p></div><span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-bold ${stateClass}`}>{stateText}</span></div><p className="mt-3 text-xs text-slate-500">{component.installed ? [component.version && `版本 ${component.version}`, formatComponentSize(component.sizeBytes)].filter(Boolean).join(' · ') : `组件 ID：${component.id}`}</p>{component.error && <p className="mt-2 break-all text-xs leading-5 text-amber-700">{component.error}</p>}<div className="mt-auto flex justify-end pt-4">{!component.installed ? <button type="button" onClick={() => void install(component)} disabled={Boolean(busyId)} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-45">{busy && <Loader2 size={14} className="animate-spin"/>}{component.compatible ? '安装组件' : '重新安装'}</button> : canUninstall ? <button type="button" onClick={() => void uninstall(component)} disabled={Boolean(busyId)} className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-45">{busy && <Loader2 size={14} className="animate-spin"/>}卸载组件</button> : <span className="text-xs text-slate-400">{component.source === 'development' ? '开发环境中由源码提供' : '随应用提供，不能单独卸载'}</span>}</div></article>;
    })}</div>
    {!loading && !components.length && <p className="mt-4 text-sm text-slate-500">没有读取到组件注册信息。</p>}
  </section>;
};

const SettingsNavigator = ({ activeSection, components, onSelect }: { activeSection: SettingsSection; components: ComponentStatus[]; onSelect: (section: SettingsSection) => void }) => {
  const installedComponentIds = new Set(components.filter(component => component.installed).map(component => component.id));
  const items: Array<{ id: SettingsSection; label: string; description: string; icon: React.ReactNode }> = [
    { id: 'general', label: '常规', description: '界面、工作目录与首页', icon: <Settings size={18}/> },
    { id: 'storage', label: '存储与转换', description: '缓存位置与输出质量', icon: <HardDrive size={18}/> },
    { id: 'import', label: '导入', description: 'SD 卡、工作文件与花絮', icon: <Download size={18}/> },
    { id: 'components', label: '组件管理', description: '安装与卸载可选组件', icon: <Puzzle size={18}/> },
  ];
  const componentItems = ([
    { id: 'team-retouch', componentId: 'team-retouch', label: '多人修脸', description: 'AI识别人物并把图片切小', icon: <UsersRound size={18}/> },
    { id: 'research-tools', componentId: 'research-tools', label: '调研整理', description: '视频分镜与资料整理', icon: <ScanSearch size={18}/> },
    { id: 'office-media-extractor', componentId: 'office-media-extractor', label: 'Office 图片提取', description: '提取文档中的内嵌图片', icon: <FileImage size={18}/> },
  ] as Array<{ id: SettingsSection; componentId: string; label: string; description: string; icon: React.ReactNode }>).filter(item => installedComponentIds.has(item.componentId));
  const renderItem = (item: typeof items[number]) => <button key={item.id} type="button" aria-current={activeSection === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)} className={`flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition ${activeSection === item.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}><span className={`mt-0.5 shrink-0 ${activeSection === item.id ? 'text-blue-600' : 'text-slate-400'}`}>{item.icon}</span><span className="min-w-0"><span className="block text-sm font-bold">{item.label}</span><span className={`mt-0.5 block text-xs leading-5 ${activeSection === item.id ? 'text-blue-600/80' : 'text-slate-400'}`}>{item.description}</span></span></button>;
  return <nav aria-label="设置分类" className="flex min-h-0 flex-1 flex-col border-r border-slate-200 p-3">
    <div className="flex items-center gap-2 px-3 pb-3 pt-2 text-sm font-bold text-slate-800"><Settings size={17} className="text-blue-600"/>设置</div>
    <div className="space-y-1">{items.map(renderItem)}</div>
    <div className="mt-3 border-t border-slate-200 pt-3"><p className="px-3 pb-1.5 text-[11px] font-bold tracking-wide text-slate-400">组件</p><div className="space-y-1">{componentItems.map(renderItem)}</div></div>
  </nav>;
};

const SettingsPage = ({ activeSection, config, components, componentInstallPath, componentsLoading, onRefreshComponents, onComponentsChanged, onSave, onNotice }: { activeSection: SettingsSection; config: AppConfig; components: ComponentStatus[]; componentInstallPath: string; componentsLoading: boolean; onRefreshComponents: () => void | Promise<void>; onComponentsChanged: () => void | Promise<void>; onSave: (config: AppConfig) => boolean | Promise<boolean>; onNotice: (message: string, duration?: number) => void }) => {
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof AppConfig,>(key: K, value: AppConfig[K]) => setDraft(current => ({ ...current, [key]: value }));
  const teamRetouchSettings = (draft.componentSettings['team-retouch'] as AppConfig['personDetection'] | undefined) || draft.personDetection;
  const researchSettings = (draft.componentSettings['research-tools'] as AppConfig['research'] | undefined) || draft.research;
  const updateTeamRetouchSettings = (next: AppConfig['personDetection']) => setDraft(current => ({ ...current, personDetection: next, componentSettings: { ...current.componentSettings, 'team-retouch': next } }));
  const updateResearchSettings = (next: AppConfig['research']) => setDraft(current => ({ ...current, research: next, componentSettings: { ...current.componentSettings, 'research-tools': next } }));
  const save = async () => {
    const workspacePath = draft.workspacePath.trim();
    if (!workspacePath || saving) return;
    setSaving(true);
    try {
      if (await onSave({ ...draft, workspacePath })) onNotice('已保存');
    } finally {
      setSaving(false);
    }
  };
  return <section className="flex min-h-full w-full flex-col bg-white"><header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-100 p-5"><h3 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Settings size={20} className="text-blue-600"/>设置</h3><button type="button" onClick={() => void save()} disabled={!draft.workspacePath.trim() || saving} className="dialog-primary disabled:cursor-not-allowed disabled:opacity-45">{saving ? '保存中…' : '保存设置'}</button></header><div className="mx-auto w-full max-w-4xl space-y-7 p-6">
    {activeSection === 'general' && <>
    <section><h4 className="text-sm font-bold text-slate-800">界面配色</h4><div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => update('theme', theme)} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">工作目录</h4><p className="mt-1 text-sm leading-6 text-slate-500">项目会直接放在选中的客户文件夹中；只有选择磁盘根目录时，才会使用根目录下的“照片流”文件夹。</p><div className="mt-4"><WorkspaceFolderPicker value={draft.workspacePath} onChange={workspacePath => update('workspacePath', workspacePath)}/></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">角色生日</h4><label className="settings-check"><input type="checkbox" checked={draft.birthdayEnabled} onChange={event => update('birthdayEnabled', event.target.checked)}/>在首页显示角色生日</label></section>
    <div className="border-t border-slate-100 pt-6"><LogSettings onNotice={onNotice}/></div>
    </>}
    {activeSection === 'storage' && <>
    <section><h4 className="text-sm font-bold text-slate-800">缩略图缓存</h4><p className="mt-1 text-sm text-slate-500">设置图片、RAW 和视频缩略图缓存的容量与位置，并可按时间清理。版本历史预览固定保存在 AppData，不会写入项目目录。</p><div className="mt-4"><MediaCacheSettings config={draft.mediaCache} onChange={mediaCache => update('mediaCache', mediaCache)}/></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">PNG 转 JPG</h4><label className="form-label">默认导出 JPG 画质</label><select value={draft.imageConversion.jpgQuality} onChange={event => update('imageConversion', { jpgQuality: Number(event.target.value) })} className="form-input"><option value={100}>最高（100）</option><option value={95}>高（95）</option><option value={85}>标准（85）</option><option value={75}>节省空间（75）</option></select></section>
    </>}
    {activeSection === 'components' && <ComponentSettings components={components} installPath={componentInstallPath} loading={componentsLoading} onRefresh={onRefreshComponents} onComponentsChanged={onComponentsChanged} onNotice={onNotice}/>}
    {activeSection === 'team-retouch' && <>
    <section><h4 className="text-sm font-bold text-slate-800">多人修脸</h4><p className="mt-1 text-sm leading-6 text-slate-500">通常手机修图软件能导出的画质长边不超过 4000 像素，因此建议将单张工作图裁剪到 4000 像素以内。相邻人物会尽量合并到同一张工作图。</p></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">人物超过 4000 像素时</h4><div className="mt-3 grid gap-3 md:grid-cols-2"><label className={`cursor-pointer rounded-xl border p-4 transition ${teamRetouchSettings.oversizeCropMode === 'face-centered' ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}><input type="radio" name="oversize-crop-mode" value="face-centered" checked={teamRetouchSettings.oversizeCropMode === 'face-centered'} onChange={() => updateTeamRetouchSettings({ ...teamRetouchSettings, oversizeCropMode: 'face-centered' })} className="mr-2"/><span className="font-bold text-slate-800">保持 4000 像素（推荐）</span><span className="mt-2 block text-xs leading-5 text-slate-500">以脸为中心裁剪，可能只保留脸和部分身体；更适合手机传输与修图。</span></label><label className={`cursor-pointer rounded-xl border p-4 transition ${teamRetouchSettings.oversizeCropMode === 'expand' ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}><input type="radio" name="oversize-crop-mode" value="expand" checked={teamRetouchSettings.oversizeCropMode === 'expand'} onChange={() => updateTeamRetouchSettings({ ...teamRetouchSettings, oversizeCropMode: 'expand' })} className="mr-2"/><span className="font-bold text-slate-800">扩大裁剪，保留完整人物</span><span className="mt-2 block text-xs leading-5 text-slate-500">工作图可以超过 4000 像素，完整保留人物，但可能会使部分手机后期软件无法导出原尺寸而影响成图画质。</span></label></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">人物检测</h4><label className="settings-check"><input type="checkbox" checked={teamRetouchSettings.useGpu} onChange={event => updateTeamRetouchSettings({ ...teamRetouchSettings, useGpu: event.target.checked })}/><span><span className="block">优先使用 GPU 进行全身人物检测</span><span className="mt-1 block text-xs leading-5 text-slate-500">关闭时固定使用 CPU；开启后若显卡不支持或运行失败，组件会自动回退 CPU。</span></span></label></section>
    </>}
    {activeSection === 'research-tools' && <>
    <section><h4 className="text-sm font-bold text-slate-800">调研整理</h4><p className="mt-1 text-sm leading-6 text-slate-500">设置调研素材读取目录、转场检测灵敏度和短片段过滤规则。</p></section>
    <section className="border-t border-slate-100 pt-6"><label className="form-label">默认读取目录</label><input type="text" value={researchSettings.defaultDir} onChange={event => updateResearchSettings({ ...researchSettings, defaultDir: event.target.value })} className="form-input font-mono"/><p className="mt-2 text-xs leading-5 text-slate-500">调研整理默认从这里读取小红书、抖音等来源的图片与视频。</p></section>
    <section className="grid gap-5 border-t border-slate-100 pt-6 md:grid-cols-2"><div><label className="form-label">检测灵敏度</label><select value={researchSettings.sensitivity} onChange={event => updateResearchSettings({ ...researchSettings, sensitivity: event.target.value as AppConfig['research']['sensitivity'] })} className="form-input"><option value="low">低</option><option value="standard">标准</option><option value="high">高</option></select><p className="mt-2 text-xs leading-5 text-slate-500">{{ low: '只保留明显硬切，截图最少。', standard: '兼顾硬切、渐变与误判率。', high: '识别更多轻微转场，截图更多。' }[researchSettings.sensitivity]}</p></div><div><label className="form-label">最小片段时长（秒）</label><input type="number" min="0.05" max="5" step="0.05" value={researchSettings.minDuration} onChange={event => updateResearchSettings({ ...researchSettings, minDuration: Math.min(5, Math.max(0.05, Number(event.target.value) || 0.05)) })} className="form-input"/><p className="mt-2 text-xs leading-5 text-slate-500">数值越大，短暂画面会被过滤，最终导出的截图越少。</p></div></section>
    </>}
    {activeSection === 'office-media-extractor' && <>
    <section><h4 className="text-sm font-bold text-slate-800">Office 图片提取</h4><p className="mt-1 text-sm leading-6 text-slate-500">组件安装后，在项目文件浏览器中右键 Word、PowerPoint 或 Excel 的 Open XML 文档，选择“提取图片”。</p></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">输出规则</h4><p className="mt-2 text-sm leading-6 text-slate-500">图片会保存到文档同目录的“文档名_media”文件夹；如果目录已存在，会自动追加 _2、_3，不会覆盖已有内容。本组件无需额外设置。</p></section>
    </>}
    {activeSection === 'import' && <>
    <section><h4 className="text-sm font-bold text-slate-800">从 SD 卡导入</h4><label className="settings-check"><input type="checkbox" checked={draft.smartImport.autoStart} onChange={event => update('smartImport', { ...draft.smartImport, autoStart: event.target.checked })}/>应用启动时自动读取 SD 卡</label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.splitLargeFiles} onChange={event => update('smartImport', { ...draft.smartImport, splitLargeFiles: event.target.checked })}/><span><span className="block">超过 4GB 的视频自动分割</span><span className="mt-1 block text-xs leading-5 text-slate-500">用于兼容部分老旧 U 盘的 FAT32 单文件大小限制，以及某些云盘的单文件上传限制。</span></span></label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.generateVideoPreview} onChange={event => update('smartImport', { ...draft.smartImport, generateVideoPreview: event.target.checked })}/><span><span className="block">生成视频预览</span><span className="mt-1 block text-xs leading-5 text-slate-500">为导入到“mov”的大型视频生成 H.264 中码率文件，储存在“mov_预览”并作为软件内快速播放源。关闭后不会在浏览时临时转码这些导入视频；其他普通视频仍可照常预览。</span></span></label></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">导入设置</h4><label className="settings-check"><input type="checkbox" checked={draft.fileImport.preserveOriginal} onChange={event => update('fileImport', { preserveOriginal: event.target.checked })}/><span><span className="block">导入后保留原始文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">开启此项后导入的文件会保留源文件。这可能会导致大量的文件重复。</span></span></label><label className="settings-check"><input type="checkbox" checked={draft.brollImport.splitLargeFiles} onChange={event => update('brollImport', { ...draft.brollImport, splitLargeFiles: event.target.checked })}/><span><span className="block">花絮视频超过 4GB 时自动分割</span><span className="mt-1 block text-xs leading-5 text-slate-500">用于兼容 FAT32 和部分云盘的单文件大小限制。</span></span></label></section>
    </>}
  </div></section>;
};

const MediaCacheSettings = ({ config, onChange }: { config: AppConfig['mediaCache']; onChange: (config: AppConfig['mediaCache']) => void }) => {
  const [info, setInfo] = useState({ path: '', sizeBytes: 0, fileCount: 0 });
  const [busy, setBusy] = useState(false);
  const [capacityInput, setCapacityInput] = useState(String(config.maxSizeGB));
  const refreshInfo = async (nextConfig = config) => {
    const result = await window.electronAPI.getMediaCacheInfo(nextConfig);
    if (result.success) setInfo(result);
  };
  useEffect(() => { refreshInfo(); }, [config.directory, config.maxSizeGB]);
  useEffect(() => { setCapacityInput(String(config.maxSizeGB)); }, [config.maxSizeGB]);
  const chooseDirectory = async () => {
    const result = await window.electronAPI.chooseCacheDirectory();
    if (!result.path) return;
    const next = { ...config, directory: result.path };
    onChange(next);
    refreshInfo(next);
  };
  const commitCapacity = () => {
    const maxSizeGB = normalizeMediaCacheSize(capacityInput);
    setCapacityInput(String(maxSizeGB));
    if (maxSizeGB !== config.maxSizeGB) onChange({ ...config, maxSizeGB });
  };
  const clearAll = async () => {
    setBusy(true);
    try {
      await window.electronAPI.clearMediaCache(config);
      await refreshInfo();
    } finally { setBusy(false); }
  };
  const sizeText = info.sizeBytes >= 1024 * 1024 * 1024 ? `${(info.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB` : `${Math.round(info.sizeBytes / 1024 / 1024)} MB`;
  return <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-end">
    <div className="space-y-4">
      <div><label className="form-label">最大缓存容量</label><div className="flex max-w-xs items-center gap-2"><input type="number" min={0} step={0.1} inputMode="decimal" value={capacityInput} onChange={event => setCapacityInput(event.target.value)} onBlur={commitCapacity} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="form-input"/><span className="text-sm font-medium text-slate-500">GB</span></div><p className="mt-2 text-xs text-slate-500">超过上限时自动清理最久未使用的缩略图。</p></div>
      <div><label className="form-label">缓存目录</label><div className="flex gap-2"><input readOnly value={info.path || config.directory || '默认应用缓存目录'} className="form-input min-w-0 font-mono text-xs"/><button onClick={chooseDirectory} className="dialog-secondary shrink-0">选择目录</button></div></div>
      <label className="settings-check"><input type="checkbox" checked={config.autoCleanup30Days} onChange={event => onChange({ ...config, autoCleanup30Days: event.target.checked })}/><span><span className="block">自动清理 30 天以前的缓存</span><span className="mt-1 block text-xs leading-5 text-slate-500">启用后会立即检查一次，并在应用运行期间每天自动检查。</span></span></label>
    </div>
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm"><p className="font-bold text-slate-800">当前缓存：{sizeText}</p><p className="mt-1 text-xs text-slate-500">{info.fileCount} 个缓存文件</p><div className="mt-3 flex flex-wrap gap-2"><button onClick={clearAll} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14}/>{busy ? '正在清理…' : '清空全部缓存'}</button></div></div>
  </div>;
};

export { WorkspaceSetupPage, SettingsNavigator, SettingsPage, MediaCacheSettings };
