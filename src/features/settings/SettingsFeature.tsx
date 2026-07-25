import React, { useState, useEffect } from 'react';
import { FolderOpen, HardDrive, Trash2, RotateCcw, Settings, Download, Puzzle, UsersRound, ScanSearch, Loader2, FileImage, Cpu, CheckCircle2, AlertTriangle, Wrench } from 'lucide-react';
import type { AppConfig, ComponentStatus } from '../../types';
import { useAppDialog } from '../../components/AppDialogProvider';

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
const formatStorageSize = (sizeBytes = 0) => sizeBytes >= 1024 ** 3
  ? `${(sizeBytes / 1024 ** 3).toFixed(sizeBytes >= 10 * 1024 ** 3 ? 1 : 2)} GB`
  : sizeBytes > 0 ? `${(sizeBytes / 1024 ** 2).toFixed(0)} MB` : '0 MB';

const TeamRetouchEngineSettings = ({ component, onRefresh, onNotice }: { component?: ComponentStatus; onRefresh: () => void | Promise<void>; onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState<'check' | 'install' | 'repair' | 'uninstall' | ''>('');
  const [progress, setProgress] = useState({ progress: 0, message: '' });
  useEffect(() => window.electronAPI.onTeamRetouchAdvancedProgress(value => {
    setProgress({ progress: Number(value.progress) || 0, message: value.message });
  }), []);
  const install = async (repair = false) => {
    if (busy || !await appDialog.confirm({
      title: repair ? '修复高级引擎吗？' : '安装高级引擎吗？',
      message: repair
        ? '修复需要重新选择与当前组件版本一致的高级引擎离线包。程序不会联网下载，基础引擎不会受到影响。'
        : '程序不会联网下载。请选择从部署盘或移动硬盘取得的高级引擎离线包；安装后约占 20–30 GB，建议预留 35 GB。',
      confirmLabel: repair ? '选择离线包并修复' : '选择离线包',
    })) return;
    setBusy(repair ? 'repair' : 'install');
    setProgress({ progress: 1, message: repair ? '正在准备修复' : '正在准备安装' });
    try {
      const result = await window.electronAPI.installTeamRetouchAdvanced({ repair });
      if (result.cancelled) return;
      if (!result.success) { onNotice(`高级引擎${repair ? '修复' : '安装'}失败：${result.error || '未知错误'}`, 8000); return; }
      onNotice(`高级引擎已${repair ? '修复' : '安装'}并通过运行验证`);
      await onRefresh();
    } finally { setBusy(''); }
  };
  const checkRequirements = async () => {
    if (busy) return;
    setBusy('check');
    setProgress({ progress: 2, message: '正在检查 WSL 2、NVIDIA 驱动和磁盘空间' });
    try {
      const result = await window.electronAPI.checkTeamRetouchAdvancedRequirements();
      if (!result.success) { onNotice(`本机条件检查未通过：${result.error || '未知错误'}`, 8000); return; }
      onNotice(result.message || '本机已满足高级引擎安装条件');
    } finally { setBusy(''); }
  };
  const uninstall = async () => {
    if (busy || !await appDialog.confirm({
      title: '卸载多人修脸高级引擎吗？',
      message: `将注销 PhotoFlowNative 并删除高级模型、Python 环境和虚拟磁盘，预计释放 ${formatStorageSize(component?.advancedSizeBytes)}。基础多人修脸仍可继续使用。`,
      confirmLabel: '卸载高级引擎', tone: 'danger',
    })) return;
    setBusy('uninstall');
    setProgress({ progress: 20, message: '正在停止并删除高级引擎' });
    try {
      const result = await window.electronAPI.uninstallTeamRetouchAdvanced();
      if (!result.success) { onNotice(`卸载高级引擎失败：${result.error || '未知错误'}`, 8000); return; }
      onNotice('高级引擎已卸载，基础多人修脸不受影响');
      await onRefresh();
    } finally { setBusy(''); }
  };
  const openFolder = async () => {
    const result = await window.electronAPI.openTeamRetouchAdvancedFolder();
    if (!result.success) onNotice(`打开高级引擎目录失败：${result.error || '未知错误'}`);
  };
  const baseAvailable = Boolean(component?.installed && component.runtimeAvailable);
  const advancedReady = Boolean(component?.advancedAvailable);
  const needsRepair = component?.advancedState === 'repair-needed';
  return <section>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-bold text-slate-800">识别引擎与安装状态</h4><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">基础引擎随“多人修脸”组件安装；高级引擎是可选的独立 WSL 环境，不会放进程序安装目录，应用升级和清理源码不会删除它。</p></div><button type="button" onClick={() => void onRefresh()} disabled={Boolean(busy)} className="dialog-secondary inline-flex items-center gap-2"><RotateCcw size={15} className={busy ? 'animate-spin' : ''}/>重新检测</button></div>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <article className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex items-start gap-3"><span className="rounded-lg bg-blue-50 p-2 text-blue-600"><Cpu size={18}/></span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><h5 className="font-bold text-slate-800">基础方案 · RTMDet</h5><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${baseAvailable ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>{baseAvailable ? '可用' : '不可用'}</span></div><p className="mt-2 text-xs leading-5 text-slate-500">检测人物、生成基础人物蒙版、规划工作图并自动拼回。支持 CPU 及 Intel、AMD、NVIDIA 的 DirectML GPU，体积小、启动快。</p><p className="mt-3 text-xs text-slate-500">{component?.provider ? `当前运行：${component.provider}` : component?.runtimeError || '等待组件状态'}</p><p className="mt-1 text-xs text-slate-400">组件占用：{formatStorageSize(component?.sizeBytes)}</p></div></div></article>
      <article className={`rounded-xl border p-4 ${advancedReady ? 'border-violet-200 bg-violet-50/30' : needsRepair ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-white'}`}><div className="flex items-start gap-3"><span className={`rounded-lg p-2 ${advancedReady ? 'bg-violet-100 text-violet-700' : needsRepair ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{advancedReady ? <CheckCircle2 size={18}/> : needsRepair ? <AlertTriangle size={18}/> : <UsersRound size={18}/>}</span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><h5 className="font-bold text-slate-800">高级方案 · PairDETR + SAM 2.1</h5><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${advancedReady ? 'bg-violet-100 text-violet-700' : needsRepair ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{advancedReady ? '可用' : needsRepair ? '需要修复' : '未安装'}</span></div><p className="mt-2 text-xs leading-5 text-slate-500">增加脸与身体的对应关系和精细人物分割，更适合多人密集、互相遮挡和复杂姿势。高级方案通过离线安装包部署，程序不会联网下载。</p><div className="mt-3 space-y-1 text-xs text-slate-500">{component?.advancedProvider && <p>当前运行：{component.advancedProvider}</p>}<p>当前占用：{component?.advancedSizeBytes ? formatStorageSize(component.advancedSizeBytes) : '未安装'}</p><p>离线包通常约 10–15 GB · 安装后约 20–30 GB · 建议预留 35 GB</p>{component?.advancedFreeBytes ? <p>目标磁盘剩余：{formatStorageSize(component.advancedFreeBytes)}</p> : null}<p className="break-all font-mono text-[11px] text-slate-400">{component?.advancedDataPath || '等待检测安装位置'}</p></div>{component?.advancedError && !advancedReady && <p className="mt-2 break-all rounded-md bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-700">{component.advancedError}</p>}</div></div><div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => void checkRequirements()} disabled={Boolean(busy) || !baseAvailable} className="dialog-secondary disabled:opacity-45">检查本机条件</button>{advancedReady ? <><button type="button" onClick={() => void openFolder()} disabled={Boolean(busy)} className="dialog-secondary inline-flex items-center gap-2"><FolderOpen size={14}/>打开安装目录</button><button type="button" onClick={() => void install(true)} disabled={Boolean(busy)} className="dialog-secondary inline-flex items-center gap-2"><Wrench size={14}/>选择离线包修复</button><button type="button" onClick={() => void uninstall()} disabled={Boolean(busy)} className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-45">卸载高级引擎</button></> : needsRepair ? <button type="button" onClick={() => void install(true)} disabled={Boolean(busy)} className="dialog-primary inline-flex items-center gap-2"><Wrench size={14}/>选择离线包修复</button> : <button type="button" onClick={() => void install(false)} disabled={Boolean(busy) || !baseAvailable} className="dialog-primary disabled:opacity-45">选择离线安装包</button>}</div></article>
    </div>
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4"><h5 className="text-xs font-bold text-slate-700">离线安装方式</h5><ol className="mt-2 grid gap-2 text-xs leading-5 text-slate-500 md:grid-cols-4"><li><span className="font-bold text-slate-700">1. 准备电脑</span><span className="mt-1 block">离线安装 NVIDIA 驱动并启用 WSL 2；如有需要，完成系统重启。</span></li><li><span className="font-bold text-slate-700">2. 接入部署盘</span><span className="mt-1 block">从移动硬盘或部署盘取得与当前组件版本一致的高级引擎离线包。</span></li><li><span className="font-bold text-slate-700">3. 选择离线包</span><span className="mt-1 block">程序校验包版本、路径安全性和 VHDX 的 SHA256 后导入，不会访问网络。</span></li><li><span className="font-bold text-slate-700">4. 运行验证</span><span className="mt-1 block">实际启动 PairDETR 与 SAM 2.1；两者都可用后才显示安装完成。</span></li></ol><p className="mt-3 text-xs leading-5 text-slate-500">离线包可以放在任意磁盘，不要手动拆分模型或复制环境文件。修复时请重新接入原部署盘并选择同版本离线包。</p></div>
    {busy && <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.progress}>
      <div className="flex justify-between gap-3 text-xs font-bold text-blue-700"><span>{progress.message || '正在处理高级引擎'}</span><span>{Math.round(progress.progress)}%</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${Math.max(2, progress.progress)}%` }} /></div>
    </div>}
  </section>;
};

const LogSettings = ({ onNotice }: { onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [clearing, setClearing] = useState(false);
  const openFolder = async () => {
    const result = await window.electronAPI.openLogsFolder();
    if (!result.success) onNotice(`打开日志文件夹失败：${result.error || '未知错误'}`, 5000);
  };
  const clear = async () => {
    if (clearing || !await appDialog.confirm({
      title: '确定清空全部应用日志吗？',
      message: '此操作无法撤销，只会删除照片流生成的日志文件。',
      confirmLabel: '清空日志',
      tone: 'danger',
    })) return;
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
  const appDialog = useAppDialog();
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
    if (busyId || !await appDialog.confirm({
      title: `确定卸载“${component.name}”吗？`,
      message: '组件文件夹会移入系统回收站。',
      confirmLabel: '卸载组件',
      tone: 'danger',
    })) return;
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
  const teamRetouchComponent = components.find(component => component.id === 'team-retouch');
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
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">项目与文件夹</h4><label className="settings-check"><input type="checkbox" checked={draft.createPlanningFolder} onChange={event => update('createPlanningFolder', event.target.checked)}/><span><span className="block">新建项目时自动创建“策划”文件夹</span><span className="mt-1 block text-xs leading-5 text-slate-500">默认开启。关闭后只创建项目根目录，不会影响已有项目。</span></span></label><div className="mt-5"><label className="form-label">文件夹默认排序方式</label><select value={draft.defaultFolderSort} onChange={event => update('defaultFolderSort', event.target.value as AppConfig['defaultFolderSort'])} className="form-input"><option value="date">修改日期（最新优先）</option><option value="name">文件名（A–Z）</option><option value="size">大小（从大到小）</option></select><p className="mt-2 text-xs leading-5 text-slate-500">打开项目文件夹时采用此顺序；仍可在文件浏览器的“排序”菜单中临时调整。</p></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">角色生日</h4><label className="settings-check"><input type="checkbox" checked={draft.birthdayEnabled} onChange={event => update('birthdayEnabled', event.target.checked)}/>在首页显示角色生日</label></section>
    </>}
    {activeSection === 'storage' && <>
    <section><h4 className="text-sm font-bold text-slate-800">缩略图缓存</h4><p className="mt-1 text-sm text-slate-500">设置图片、RAW 和视频缩略图缓存的容量与位置，并可按时间清理。版本历史预览固定保存在 AppData，不会写入项目目录。</p><div className="mt-4"><MediaCacheSettings config={draft.mediaCache} onChange={mediaCache => update('mediaCache', mediaCache)}/></div></section>
    <InterfaceCacheSettings onNotice={onNotice}/>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">已删除项目数据</h4><label className="settings-check"><input type="checkbox" checked={draft.autoCleanupDeletedProjectData} onChange={event => update('autoCleanupDeletedProjectData', event.target.checked)}/><span><span className="block">是否自动清理已删除项目的数据</span><span className="mt-1 block text-xs leading-5 text-slate-500">默认开启，每天第一次启动软件时检查一次。仅当项目条目已不在系统回收站、原项目路径也不存在时，才会清理数据库记录、项目专属文件和缩略图缓存；无法确认时会保留数据。</span></span></label></section>
    <div className="border-t border-slate-100 pt-6"><LogSettings onNotice={onNotice}/></div>
    </>}
    {activeSection === 'components' && <ComponentSettings components={components} installPath={componentInstallPath} loading={componentsLoading} onRefresh={onRefreshComponents} onComponentsChanged={onComponentsChanged} onNotice={onNotice}/>}
    {activeSection === 'team-retouch' && <>
    <section><h4 className="text-sm font-bold text-slate-800">多人修脸</h4><p className="mt-1 text-sm leading-6 text-slate-500">通常手机修图软件能导出的画质长边不超过 4000 像素，因此建议将单张工作图裁剪到 4000 像素以内。相邻人物会尽量合并到同一张工作图。</p></section>
    <div className="border-t border-slate-100 pt-6"><TeamRetouchEngineSettings component={teamRetouchComponent} onRefresh={onRefreshComponents} onNotice={onNotice}/></div>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">默认识别模式</h4><p className="mt-1 text-xs leading-5 text-slate-500">“多人修脸”界面仍可为单次任务临时切换。高级模式不可用时，只有“自动”会安全降级。</p><div className="mt-3 grid gap-3 md:grid-cols-3">{([
      ['auto', '自动（推荐）', '高级可用时使用高级方案，否则使用基础方案完成任务。'],
      ['basic', '基础模式', '固定使用 RTMDet，不启动 WSL，速度快且资源占用较低。'],
      ['advanced', '高级模式', '必须使用 PairDETR + SAM2；不可用时停止并提示修复。'],
    ] as const).map(([mode, label, description]) => <label key={mode} className={`cursor-pointer rounded-xl border p-4 transition ${teamRetouchSettings.backendMode === mode ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'} ${mode === 'advanced' && !teamRetouchComponent?.advancedAvailable ? 'opacity-60' : ''}`}><input type="radio" name="team-retouch-backend-mode" value={mode} checked={teamRetouchSettings.backendMode === mode} disabled={mode === 'advanced' && !teamRetouchComponent?.advancedAvailable} onChange={() => updateTeamRetouchSettings({ ...teamRetouchSettings, backendMode: mode })} className="mr-2"/><span className="font-bold text-slate-800">{label}</span><span className="mt-2 block text-xs leading-5 text-slate-500">{description}</span></label>)}</div></section>
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
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">PNG 转 JPG</h4><label className="form-label">默认导出 JPG 画质，此为在文件夹选择该功能之后的默认媒体文件转换画质。此功能用于部分软件无法直接打开png文件的情况。</label><select value={draft.imageConversion.jpgQuality} onChange={event => update('imageConversion', { jpgQuality: Number(event.target.value) })} className="form-input"><option value={100}>最高（100）</option><option value={95}>高（95）</option><option value={85}>标准（85）</option><option value={75}>节省空间（75）</option></select></section>
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
      <label className="settings-check"><input type="checkbox" checked={config.autoCleanup30Days} onChange={event => onChange({ ...config, autoCleanup30Days: event.target.checked })}/><span><span className="block">自动清理 30 天以前的缓存</span><span className="mt-1 block text-xs leading-5 text-slate-500">启用后每天第一次启动软件时检查一次，同时移除已经确认不存在的源文件索引；当天再次启动不会重复检查。</span></span></label>
    </div>
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm"><p className="font-bold text-slate-800">当前缓存：{sizeText}</p><p className="mt-1 text-xs text-slate-500">{info.fileCount} 个缓存文件</p><div className="mt-3 flex flex-wrap gap-2"><button onClick={clearAll} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14}/>{busy ? '正在清理…' : '清空全部缓存'}</button></div></div>
  </div>;
};

const InterfaceCacheSettings = ({ onNotice }: { onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const clear = async () => {
    if (busy || !await appDialog.confirm({
      title: '确定清理界面缓存吗？',
      message: '软件会自动管理这部分缓存，通常只需在释放磁盘空间时清理。',
      confirmLabel: '清理缓存',
      tone: 'danger',
    })) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.clearInterfaceCache();
      if (!result.success) { onNotice(`清理界面缓存失败：${result.error || '未知错误'}`); return; }
      const clearedMB = Math.round((result.clearedBytes || 0) / 1024 / 1024);
      onNotice(`界面缓存已清理${clearedMB ? `，释放约 ${clearedMB} MB` : ''}`);
    } finally {
      setBusy(false);
    }
  };
  return <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">界面缓存</h4><p className="mt-1 text-sm leading-6 text-slate-500">软件自身有自动清理和容量淘汰机制。除非需要释放磁盘空间或界面资源显示异常，否则不建议经常清理。</p><button type="button" disabled={busy} onClick={() => void clear()} className="dialog-secondary mt-4 inline-flex items-center gap-2 disabled:opacity-50"><Trash2 size={14}/>{busy ? '正在清理…' : '清理界面缓存'}</button></section>;
};

export { WorkspaceSetupPage, SettingsNavigator, SettingsPage, MediaCacheSettings };
