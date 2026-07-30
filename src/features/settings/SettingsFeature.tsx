import React, { useState, useEffect, useRef } from 'react';
import { FolderOpen, HardDrive, Trash2, RotateCcw, Settings, Download, Puzzle, UsersRound, ScanSearch, Loader2, Cpu, Wrench, ExternalLink, AtSign, Scale, GripVertical, MemoryStick, FileText, CheckCircle2, Video, Image as ImageIcon, GitBranch, ChevronUp, ChevronDown, Crop, Heart, ShieldCheck } from 'lucide-react';
import { PROJECT_TOOLBAR_ACTION_IDS } from '../../types';
import type { AppConfig, ComponentStatus, LegalDocumentId, PrivacyConsentState, ProjectToolbarActionId } from '../../types';
import { useAppDialog } from '../../components/AppDialogProvider';
import { FORMAL_MODEL_LICENSES } from '../../licenses/modelLicenses';
import { THIRD_PARTY_SOFTWARE_LICENSES } from '../../licenses/softwareLicenses';

const normalizeMediaCacheSize = (value: unknown, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};
export type SettingsSection = 'general' | 'privacy' | 'storage' | 'components' | 'import' | 'team-retouch' | 'inspiration-library' | 'about';

export const PrivacyConsentPage = ({ onAccept }: { onAccept: () => void | Promise<void> }) => {
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [acceptedTelemetry, setAcceptedTelemetry] = useState(false);
  const [saving, setSaving] = useState(false);
  const ready = acceptedLegal && acceptedTelemetry;
  const open = (id: 'privacy' | 'terms' | 'information-list' | 'third-parties') => void window.electronAPI.openLegalDocument(id);
  const accept = async () => {
    if (!ready || saving) return;
    setSaving(true);
    try { await onAccept(); } finally { setSaving(false); }
  };
  return <main className="fixed inset-0 z-[1200] flex items-center justify-center overflow-auto bg-slate-950/90 p-6">
    <section className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-7 shadow-2xl">
      <div className="flex items-start gap-4"><span className="rounded-2xl bg-blue-50 p-3 text-blue-600"><ShieldCheck size={28}/></span><div><h1 className="text-xl font-bold text-slate-900">内测版隐私与数据确认</h1><p className="mt-2 text-sm leading-6 text-slate-600">照片流当前为受控内测版。参加内测必须发送使用统计和崩溃报告；不同意时不能进入本次内测，可退出软件。统计不上传照片、文件名、完整路径或项目名称等隐私信息。</p></div></div>
      <div className="mt-6 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <label className="flex cursor-pointer items-start gap-3"><input type="checkbox" checked={acceptedLegal} onChange={event => setAcceptedLegal(event.target.checked)} className="mt-1"/><span className="text-sm leading-6 text-slate-700">我已阅读并同意 <button type="button" onClick={event => { event.preventDefault(); open('terms'); }} className="font-bold text-blue-600 hover:underline">《用户协议》</button> 和 <button type="button" onClick={event => { event.preventDefault(); open('privacy'); }} className="font-bold text-blue-600 hover:underline">《隐私政策》</button></span></label>
        <label className="flex cursor-pointer items-start gap-3"><input type="checkbox" checked={acceptedTelemetry} onChange={event => setAcceptedTelemetry(event.target.checked)} className="mt-1"/><span><span className="block text-sm font-bold text-slate-700">同意发送使用统计和崩溃报告（内测必选）</span><span className="mt-1 block text-xs leading-5 text-slate-500">使用统计包括随机安装ID、会话ID、版本、平台、功能代号、时间和数量区间；崩溃报告包括错误类型、调用栈和脱敏后的日志尾部。</span></span></label>
      </div>
      <div className="mt-4 flex flex-wrap gap-3 text-xs"><button type="button" onClick={() => open('information-list')} className="font-bold text-blue-600 hover:underline">查看个人信息清单</button><button type="button" onClick={() => open('third-parties')} className="font-bold text-blue-600 hover:underline">查看第三方服务清单</button></div>
      <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => window.electronAPI.closeWindow()} className="dialog-secondary">不同意并退出</button><button type="button" disabled={!ready || saving} onClick={() => void accept()} className="dialog-primary disabled:cursor-not-allowed disabled:opacity-45">{saving ? '正在保存…' : '同意并进入内测'}</button></div>
    </section>
  </main>;
};

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

const offerPackageCleanup = async ({ appDialog, kind, label, packageSizeBytes, repairHint, onNotice }: {
  appDialog: ReturnType<typeof useAppDialog>;
  kind: 'advanced';
  label: string;
  packageSizeBytes?: number;
  repairHint?: string;
  onNotice: (message: string, duration?: number) => void;
}) => {
  if (!packageSizeBytes) return;
  const size = formatStorageSize(packageSizeBytes);
  if (!await appDialog.confirm({
    title: '删除已使用的安装包吗？',
    message: `${label}已经安装并通过校验。删除原 ZIP 可以立即释放约 ${size} 空间，已安装的功能不会受影响。`,
    detail: repairHint || '以后如需重新安装，需要再次把对应 ZIP 复制到组件目录。',
    confirmLabel: `删除并释放 ${size}`,
    cancelLabel: '保留安装包',
    tone: 'danger',
  })) return;
  const deleted = await window.electronAPI.deleteComponentPackage(kind);
  if (!deleted.success) {
    onNotice(`删除安装包失败：${deleted.error || '未知错误'}`, 6000);
    return;
  }
  onNotice(`安装包已删除，释放约 ${formatStorageSize(deleted.deletedBytes || packageSizeBytes)}`);
};

const IdentityModelSettings = ({ component }: { component?: ComponentStatus }) => {
  const ready = Boolean(component?.installed && component.identityAvailable && component.faceBackend === 'adaface-ir18' && component.bodyBackend === 'osnet-x1');
  return <section className="mt-5">
    <div className="flex items-start gap-3">
      <span className="rounded-lg bg-cyan-100 p-2 text-cyan-700"><ScanSearch size={18}/></span>
      <div><h5 className="font-bold text-slate-800">跨图片人物身份识别</h5><p className="mt-1 text-xs leading-5 text-slate-500">根据脸部与身体特征，将多张照片里的同一个人归到一起。</p></div>
    </div>
    <div className="mt-3">
      <article className={`rounded-xl border p-4 ${ready ? 'border-cyan-200 bg-cyan-50/30' : 'border-amber-200 bg-amber-50/40'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h6 className="font-bold text-slate-800">YuNet + AdaFace IR-18 + OSNet x1.0</h6><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${ready ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{ready ? '可用' : '需要更新组件'}</span></div>
        <p className="mt-2 text-xs leading-5 text-slate-500">改善低质量人脸和身体特征识别；无需 Python、PyTorch 或自行编译。</p>
        <p className="mt-3 text-xs font-bold text-slate-700">安装：三个模型均随“团片协作”组件安装，无需额外模型包。</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">硬件：CPU 可运行；Intel、AMD、NVIDIA 显卡可选用 DirectML 加速，不要求 CUDA 或 WSL。</p>
        {component?.identityError && <p className="mt-3 break-all rounded-md bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-700">人物身份识别模型检测失败：{component.identityError}</p>}
      </article>
    </div>
  </section>;
};

const TeamRetouchEngineSettings = ({ component, onRefresh, onNotice }: { component?: ComponentStatus; onRefresh: () => void | Promise<void>; onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState<'check' | 'install' | 'repair' | 'uninstall' | ''>('');
  const [progress, setProgress] = useState({ progress: 0, message: '' });
  useEffect(() => window.electronAPI.onTeamRetouchAdvancedProgress(value => {
    setProgress({ progress: Number(value.progress) || 0, message: value.message });
  }), []);
  const install = async (repair = false) => {
    if (busy || !await appDialog.confirm({
      title: repair ? '修复人物检测增强版吗？' : '安装人物检测增强版吗？',
      message: repair
        ? '程序将从上方显示的“团片协作组件目录”读取并校验当前版本的高级包，然后替换需要修复的环境。'
        : '请先把照片流提供的高级引擎 ZIP 放入上方显示的“团片协作组件目录”。程序会校验版本和 SHA-256，然后注册预封装环境；用户不需要编译。',
      confirmLabel: repair ? '修复检测增强包' : '安装检测增强包',
    })) return;
    setBusy(repair ? 'repair' : 'install');
    setProgress({ progress: 1, message: repair ? '正在准备修复' : '正在准备安装' });
    try {
      const result = await window.electronAPI.installTeamRetouchAdvanced({ repair });
      if (result.cancelled) return;
      if (!result.success) { onNotice(`人物检测增强版${repair ? '修复' : '安装'}失败：${result.error || '未知错误'}`, 8000); return; }
      onNotice(`人物检测增强版已${repair ? '修复' : '安装'}并通过运行验证`);
      await offerPackageCleanup({ appDialog, kind: 'advanced', label: '人物检测增强包', packageSizeBytes: result.packageSizeBytes, repairHint: '以后如需修复或重新安装人物检测增强版，需要再次把高级引擎 ZIP 复制到团片协作组件目录。', onNotice });
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
      title: '卸载人物检测增强版吗？',
      message: `将注销照片流本地增强环境并删除 PairDETR、SAM 2.1、Python 环境和虚拟磁盘，预计释放 ${formatStorageSize(component?.advancedSizeBytes)}。两个基础版和身份识别增强版不受影响。`,
      confirmLabel: '卸载检测增强版', tone: 'danger',
    })) return;
    setBusy('uninstall');
    setProgress({ progress: 20, message: '正在停止并删除高级引擎' });
    try {
      const result = await window.electronAPI.uninstallTeamRetouchAdvanced();
      if (!result.success) { onNotice(`卸载人物检测增强版失败：${result.error || '未知错误'}`, 8000); return; }
      onNotice('人物检测增强版已卸载，基础版不受影响');
      await onRefresh();
    } finally { setBusy(''); }
  };
  const openComponentFolder = async () => {
    const result = await window.electronAPI.openComponentsFolder('team-retouch');
    if (!result.success) onNotice(`打开团片协作组件目录失败：${result.error || '未知错误'}`);
  };
  const baseAvailable = Boolean(component?.installed && component.runtimeAvailable);
  const advancedReady = Boolean(component?.advancedAvailable);
  const needsRepair = component?.advancedState === 'repair-needed';
  return <section>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h4 className="text-sm font-bold text-slate-800">识别能力与安装</h4><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">人物检测与裁图保留 RTMDet 基础版和可选 CUDA 增强版；跨图片人物身份识别统一使用随组件安装的增强模型。</p></div>
      <button type="button" onClick={() => void onRefresh()} disabled={Boolean(busy)} className="dialog-secondary inline-flex items-center gap-2"><RotateCcw size={15} className={busy ? 'animate-spin' : ''}/>重新检测</button>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
      <div className="min-w-0 flex-1"><p className="text-xs font-bold text-slate-700">团片协作组件目录</p><p className="mt-1 break-all font-mono text-[11px] leading-5 text-slate-600">{component?.packagePath || '等待读取组件目录'}</p><p className="mt-1 text-xs text-slate-500">人物检测增强 ZIP 原样放在这里，无需解压；身份识别模型已经包含在组件 ZIP 中。</p></div>
      <button type="button" onClick={() => void openComponentFolder()} className="dialog-secondary inline-flex items-center gap-2"><FolderOpen size={14}/>打开目录</button>
    </div>

    <section className="mt-5">
      <div className="flex items-start gap-3"><span className="rounded-lg bg-blue-50 p-2 text-blue-600"><Cpu size={18}/></span><div><h5 className="font-bold text-slate-800">人物检测与裁图</h5><p className="mt-1 text-xs leading-5 text-slate-500">识别照片中的人物、确定裁图范围并生成蒙版。</p></div></div>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3"><h6 className="font-bold text-slate-800">基础版 · RTMDet</h6><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${baseAvailable ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>{baseAvailable ? '可用' : '不可用'}</span></div>
          <p className="mt-2 text-xs leading-5 text-slate-500">适合普通人物检测和基础实例分割，启动快，并可在高级版不可用时继续完成任务。</p>
          <p className="mt-3 text-xs font-bold text-slate-700">安装：随“团片协作”基础组件自动安装，无需额外操作。</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">硬件：CPU 可运行；Intel、AMD、NVIDIA 显卡可选用 DirectML 加速。</p>
          <div className="mt-3 space-y-1 text-xs text-slate-400"><p>{component?.provider ? `当前运行：${component.provider}` : component?.runtimeError || '等待组件状态'}</p><p>组件占用：{formatStorageSize(component?.sizeBytes)}</p></div>
        </article>
        <article className={`rounded-xl border p-4 ${advancedReady ? 'border-violet-200 bg-violet-50/30' : needsRepair ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-white'}`}>
          <div className="flex items-center justify-between gap-3"><h6 className="font-bold text-slate-800">增强版 · PairDETR + SAM 2.1</h6><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${advancedReady ? 'bg-violet-100 text-violet-700' : needsRepair ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{advancedReady ? '可用' : needsRepair ? '需要修复' : '未安装'}</span></div>
          <p className="mt-2 text-xs leading-5 text-slate-500">改善多人密集、相互遮挡、脸与身体对应及精细分割。</p>
          <p className="mt-3 text-xs font-bold text-slate-700">安装：将照片流团片协作高级包 ZIP 放入上方目录，再检查条件并安装。</p>
          <div className="mt-3 rounded-lg border border-violet-100 bg-white/70 p-3 text-xs leading-5 text-slate-600">
            <p className="font-bold text-slate-700">安装硬性条件</p>
            <p>Windows x64、WSL 2、支持 WSL CUDA 的 NVIDIA 显卡与驱动、目标磁盘至少 35 GB 可用空间。</p>
            <p className="mt-1 text-slate-500">建议：至少 8 GB 显存、16 GB 系统内存；超大图片和多人密集场景建议更高。显存与内存是性能建议，不作为安装硬门槛。</p>
          </div>
          <div className="mt-3 space-y-1 text-xs text-slate-400">{component?.advancedProvider && <p>当前运行：{component.advancedProvider}</p>}<p>当前占用：{component?.advancedSizeBytes ? formatStorageSize(component.advancedSizeBytes) : '未安装'}</p>{component?.advancedFreeBytes ? <p>目标磁盘剩余：{formatStorageSize(component.advancedFreeBytes)}</p> : null}</div>
          {component?.advancedError && !advancedReady && <p className="mt-3 break-all rounded-md bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-700">{component.advancedError}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" title="检查 WSL 2、NVIDIA 显卡与驱动、目标磁盘空间" onClick={() => void checkRequirements()} disabled={Boolean(busy) || !baseAvailable} className="dialog-secondary disabled:opacity-45">检查安装条件</button>
            {advancedReady ? <><button type="button" onClick={() => void install(true)} disabled={Boolean(busy)} className="dialog-secondary inline-flex items-center gap-2"><Wrench size={14}/>修复增强包</button><button type="button" onClick={() => void uninstall()} disabled={Boolean(busy)} className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-45">卸载增强版</button></> : needsRepair ? <button type="button" onClick={() => void install(true)} disabled={Boolean(busy)} className="dialog-primary inline-flex items-center gap-2"><Wrench size={14}/>修复增强包</button> : <button type="button" onClick={() => void install(false)} disabled={Boolean(busy) || !baseAvailable} className="dialog-primary disabled:opacity-45">安装检测增强包</button>}
          </div>
        </article>
      </div>
    </section>

    <IdentityModelSettings component={component}/>
    {busy && <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.progress}>
      <div className="flex justify-between gap-3 text-xs font-bold text-blue-700"><span>{progress.message || '正在处理人物检测增强版'}</span><span>{Math.round(progress.progress)}%</span></div>
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
  const openFolder = async (componentId?: string) => {
    const result = await window.electronAPI.openComponentsFolder(componentId);
    if (!result.success) onNotice(`打开组件文件夹失败：${result.error || '未知错误'}`);
  };
  const install = async (component: ComponentStatus) => {
    if (busyId) return;
    setBusyId(component.id);
    try {
      const result = await window.electronAPI.installComponent(component.id);
      if (result.cancelled) return;
      if (!result.success) { onNotice(`安装“${component.name}”失败：${result.error || '未知错误'}`, 5000); return; }
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
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-bold text-slate-800">组件安装与卸载</h4><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">点击安装后直接选择预编译 ZIP。照片流会在临时目录中解压、校验并复制到用户组件目录，不会移动或删除你选择的原 ZIP；不需要安装 Python 或自行编译。</p></div><div className="flex gap-2"><button type="button" onClick={() => void onRefresh()} disabled={loading} className="dialog-secondary inline-flex items-center gap-2"><RotateCcw size={15} className={loading ? 'animate-spin' : ''}/>刷新状态</button><button type="button" onClick={() => void openFolder()} className="dialog-secondary inline-flex items-center gap-2"><FolderOpen size={15}/>打开组件根目录</button></div></div>
    {installPath && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><p className="text-xs font-bold text-slate-500">组件根目录</p><p className="mt-1 break-all font-mono text-xs text-slate-600">{installPath}</p></div>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">{components.map(component => {
      const stateText = !component.installed ? (component.compatible ? '未安装' : '不兼容') : component.source === 'development' ? '开发组件' : '已安装';
      const stateClass = component.installed ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : component.compatible ? 'text-slate-600 bg-slate-50 border-slate-200' : 'text-amber-700 bg-amber-50 border-amber-200';
      const busy = busyId === component.id;
      const canUninstall = component.installed && component.source === 'user';
      return <article key={component.id} className="flex flex-col rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><h5 className="text-sm font-bold text-slate-800">{component.name}</h5><p className="mt-1 text-xs leading-5 text-slate-500">{component.description}</p></div><span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-bold ${stateClass}`}>{stateText}</span></div><p className="mt-3 text-xs text-slate-500">{component.installed ? [component.version && `版本 ${component.version}`, formatComponentSize(component.sizeBytes)].filter(Boolean).join(' · ') : `组件 ID：${component.id}`}</p>{component.packagePath && <p className="mt-2 break-all font-mono text-[11px] leading-5 text-slate-400">{component.packagePath}</p>}{component.error && <p className="mt-2 break-all text-xs leading-5 text-amber-700">{component.error}</p>}<div className="mt-auto flex justify-end gap-2 pt-4"><button type="button" onClick={() => void openFolder(component.id)} className="dialog-secondary inline-flex items-center gap-1.5"><FolderOpen size={13}/>打开目录</button>{!component.installed ? <button type="button" onClick={() => void install(component)} disabled={Boolean(busyId)} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-45">{busy && <Loader2 size={14} className="animate-spin"/>}{component.compatible ? '安装组件' : '重新安装'}</button> : canUninstall ? <button type="button" onClick={() => void uninstall(component)} disabled={Boolean(busyId)} className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-45">{busy && <Loader2 size={14} className="animate-spin"/>}卸载组件</button> : <span className="text-xs text-slate-400">{component.source === 'development' ? '开发环境中由源码提供' : '组件不在用户组件目录中'}</span>}</div></article>;
    })}</div>
    {!loading && !components.length && <p className="mt-4 text-sm text-slate-500">没有读取到组件注册信息。</p>}
  </section>;
};

const SettingsNavigator = ({ activeSection, components, onSelect }: { activeSection: SettingsSection; components: ComponentStatus[]; onSelect: (section: SettingsSection) => void }) => {
  const installedComponentIds = new Set(components.filter(component => component.installed).map(component => component.id));
  const items: Array<{ id: SettingsSection; label: string; description: string; icon: React.ReactNode }> = [
    { id: 'general', label: '常规', description: '界面、工作目录与首页', icon: <Settings size={18}/> },
    { id: 'storage', label: '存储', description: '缓存、日志与清理', icon: <HardDrive size={18}/> },
    { id: 'import', label: '导入', description: 'SD 卡、工作文件与花絮', icon: <Download size={18}/> },
    { id: 'inspiration-library', label: '灵感库', description: '素材整理、文档图片与项目策划', icon: <ScanSearch size={18}/> },
    { id: 'components', label: '组件管理', description: '安装与卸载可选组件', icon: <Puzzle size={18}/> },
  ];
  const componentItems = ([
    { id: 'team-retouch', componentId: 'team-retouch', label: '团片协作', description: 'AI识别人物并把图片切小', icon: <UsersRound size={18}/> },
  ] as Array<{ id: SettingsSection; componentId: string; label: string; description: string; icon: React.ReactNode }>).filter(item => installedComponentIds.has(item.componentId));
  const renderItem = (item: typeof items[number]) => <button key={item.id} type="button" aria-current={activeSection === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)} className={`flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition ${activeSection === item.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}><span className={`mt-0.5 shrink-0 ${activeSection === item.id ? 'text-blue-600' : 'text-slate-400'}`}>{item.icon}</span><span className="min-w-0"><span className="block text-sm font-bold">{item.label}</span><span className={`mt-0.5 block text-xs leading-5 ${activeSection === item.id ? 'text-blue-600/80' : 'text-slate-400'}`}>{item.description}</span></span></button>;
  return <nav aria-label="设置分类" className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain border-r border-slate-200 p-3">
    <div className="flex items-center gap-2 px-3 pb-3 pt-2 text-sm font-bold text-slate-800"><Settings size={17} className="text-blue-600"/>设置</div>
    <div className="space-y-1">{items.map(renderItem)}</div>
    <div className="mt-3 border-t border-slate-200 pt-3"><p className="px-3 pb-1.5 text-[11px] font-bold tracking-wide text-slate-400">组件</p><div className="space-y-1">{componentItems.map(renderItem)}</div></div>
    <div className="mt-3 space-y-1 border-t border-slate-200 pt-3">
      {renderItem({ id: 'about', label: '关于', description: '版本、项目与开源许可', icon: <AtSign size={18}/> })}
      {renderItem({ id: 'privacy', label: '隐私与数据', description: '内测统计、人脸信息与法律文件', icon: <ShieldCheck size={18}/> })}
    </div>
  </nav>;
};

const PROJECT_TOOLBAR_ITEMS: Record<ProjectToolbarActionId, { label: string; description: string; icon: React.ReactNode }> = {
  'smart-import': { label: '从 SD 卡导入', description: '打开项目的 SD 卡整理导入面板', icon: <MemoryStick size={17}/> },
  'filename-selection': { label: '从文件名选片', description: '按文件名把选中的素材整理到选片文件夹', icon: <FileText size={17}/> },
  'select-media': { label: '选片', description: '把当前选择的图片或视频加入选片结果', icon: <CheckCircle2 size={17}/> },
  storyboard: { label: '提取分镜帧', description: '从所选视频或文件夹提取分镜帧', icon: <Video size={17}/> },
  'screenshot-main-image': { label: '提取截图主图', description: '从所选截图中识别并截取主要图片区域', icon: <Crop size={17}/> },
  photoshop: { label: '在 PS 中打开', description: '把所选图片或 RAW 发送到 Photoshop', icon: <span className="flex h-[17px] w-[17px] items-center justify-center rounded border border-blue-400 text-[9px] font-bold text-blue-600">Ps</span> },
  'png-converter': { label: 'PNG 转 JPG', description: '转换所选 PNG 文件或文件夹', icon: <ImageIcon size={17}/> },
  'version-management': { label: '版本管理', description: '管理素材版本或标记进度文件夹', icon: <GitBranch size={17}/> },
  'team-retouch': { label: '团片协作', description: '打开项目的团片协作工作区', icon: <UsersRound size={17}/> },
  'final-versions': { label: '浏览最终版', description: '浏览项目中所有已经标记为最终版的图片', icon: <Heart size={17}/> },
};

const ProjectToolbarSettingsEditor = ({ value, onChange }: { value: AppConfig['projectToolbar']; onChange: (value: AppConfig['projectToolbar']) => void }) => {
  const [draggedId, setDraggedId] = useState<ProjectToolbarActionId>();
  const hidden = new Set(value.hidden);
  const reorder = (source: ProjectToolbarActionId, target: ProjectToolbarActionId) => {
    if (source === target) return;
    const next = [...value.order];
    const sourceIndex = next.indexOf(source);
    const targetIndex = next.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    onChange({ ...value, order: next });
  };
  const move = (id: ProjectToolbarActionId, offset: -1 | 1) => {
    const index = value.order.indexOf(id);
    const target = value.order[index + offset];
    if (target) reorder(id, target);
  };
  const toggle = (id: ProjectToolbarActionId) => onChange({
    ...value,
    hidden: hidden.has(id) ? value.hidden.filter(item => item !== id) : [...value.hidden, id],
  });
  return <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50/60">
    {value.order.map((id, index) => {
      const item = PROJECT_TOOLBAR_ITEMS[id];
      const visible = !hidden.has(id);
      return <div key={id} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); if (draggedId) reorder(draggedId, id); setDraggedId(undefined); }} className={`flex items-center gap-3 border-b border-slate-200 px-3 py-3 last:border-b-0 ${draggedId === id ? 'bg-blue-50 opacity-60' : 'bg-white'}`}>
        <button type="button" draggable onDragStart={event => { setDraggedId(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); }} onDragEnd={() => setDraggedId(undefined)} title="拖动调整顺序" aria-label={`拖动“${item.label}”调整顺序`} className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-100 active:cursor-grabbing"><GripVertical size={17}/></button>
        <span className={`shrink-0 ${visible ? 'text-blue-600' : 'text-slate-300'}`}>{item.icon}</span>
        <span className={`min-w-0 flex-1 ${visible ? '' : 'opacity-50'}`}><span className="block text-sm font-bold text-slate-700">{item.label}</span><span className="mt-0.5 block text-xs text-slate-400">{item.description}</span></span>
        <div className="flex shrink-0 items-center gap-1"><button type="button" disabled={index === 0} onClick={() => move(id, -1)} title="上移" aria-label={`上移“${item.label}”`} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"><ChevronUp size={15}/></button><button type="button" disabled={index === value.order.length - 1} onClick={() => move(id, 1)} title="下移" aria-label={`下移“${item.label}”`} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"><ChevronDown size={15}/></button></div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={visible} onChange={() => toggle(id)}/>显示</label>
      </div>;
    })}
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2.5"><span className="text-xs text-slate-400">拖动左侧手柄自由排序，更改会立即保存。</span><button type="button" onClick={() => onChange({ order: [...PROJECT_TOOLBAR_ACTION_IDS], hidden: [] })} className="text-xs font-bold text-blue-600 hover:text-blue-700">恢复默认</button></div>
  </div>;
};

const SettingsPage = ({ activeSection, config, components, componentInstallPath, componentsLoading, onRefreshComponents, onComponentsChanged, onSave, getDefaultSettings, onNotice }: { activeSection: SettingsSection; config: AppConfig; components: ComponentStatus[]; componentInstallPath: string; componentsLoading: boolean; onRefreshComponents: () => void | Promise<void>; onComponentsChanged: () => void | Promise<void>; onSave: (config: AppConfig) => boolean | Promise<boolean>; getDefaultSettings: () => AppConfig | Promise<AppConfig>; onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [draft, setDraft] = useState(config);
  const pendingSaveRef = useRef<AppConfig | null>(null);
  const savingRef = useRef(false);
  const flushPendingSettings = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    let changed = false;
    try {
      while (pendingSaveRef.current) {
        const next = pendingSaveRef.current;
        pendingSaveRef.current = null;
        changed = await onSave({ ...next, workspacePath: next.workspacePath.trim() }) || changed;
      }
    } finally {
      savingRef.current = false;
    }
    if (changed) onNotice('已更改设置');
    if (pendingSaveRef.current) void flushPendingSettings();
  };
  const commitSettings = (next: AppConfig) => {
    setDraft(next);
    pendingSaveRef.current = next;
    void flushPendingSettings();
  };
  const update = <K extends keyof AppConfig,>(key: K, value: AppConfig[K]) => commitSettings({ ...draft, [key]: value });
  const teamRetouchSettings = (draft.componentSettings['team-retouch'] as AppConfig['personDetection'] | undefined) || draft.personDetection;
  const teamRetouchComponent = components.find(component => component.id === 'team-retouch');
  const inspirationLibrarySettings = draft.inspirationLibrary;
  const updateTeamRetouchSettings = (next: AppConfig['personDetection']) => commitSettings({ ...draft, personDetection: next, componentSettings: { ...draft.componentSettings, 'team-retouch': next } });
  const updateInspirationLibrarySettings = (next: AppConfig['inspirationLibrary']) => commitSettings({ ...draft, inspirationLibrary: next });
  const updateInspirationLibraryRoot = (rootPath: string) => updateInspirationLibrarySettings({ ...inspirationLibrarySettings, rootPath });
  const restoreDefaults = async () => {
    if (!await appDialog.confirm({
      title: '恢复默认设置吗？',
      message: '除当前工作目录外，界面、导入、存储、灵感库和组件偏好都会恢复为默认值。更改会立即生效。',
      confirmLabel: '恢复默认设置',
    })) return;
    const defaults = await getDefaultSettings();
    commitSettings({ ...defaults, workspacePath: draft.workspacePath.trim() || defaults.workspacePath });
  };
  return <section className="flex min-h-full w-full flex-col bg-white"><header className="sticky top-0 z-20 flex items-center border-b border-slate-200 bg-slate-100 p-5"><h3 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Settings size={20} className="text-blue-600"/>设置</h3></header><div className="mx-auto w-full max-w-4xl space-y-7 p-6">
    {activeSection === 'general' && <>
    <section><h4 className="text-sm font-bold text-slate-800">界面配色</h4><div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => update('theme', theme)} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">工作目录</h4><p className="mt-1 text-sm leading-6 text-slate-500">项目会直接放在选中的客户文件夹中；只有选择磁盘根目录时，才会使用根目录下的“照片流”文件夹。</p><div className="mt-4"><WorkspaceFolderPicker value={draft.workspacePath} onChange={workspacePath => update('workspacePath', workspacePath)}/></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">项目与文件夹</h4><div className="mt-5"><label className="form-label">文件夹默认排序方式</label><select value={draft.defaultFolderSort} onChange={event => update('defaultFolderSort', event.target.value as AppConfig['defaultFolderSort'])} className="form-input"><option value="date">修改日期（最新优先）</option><option value="name">文件名（A–Z）</option><option value="size">大小（从大到小）</option></select><p className="mt-2 text-xs leading-5 text-slate-500">打开项目文件夹时采用此顺序；仍可在文件浏览器的“排序”菜单中临时调整。</p></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">项目工具栏</h4><p className="mt-1 text-sm leading-6 text-slate-500">调整项目文件浏览器中工作流按钮的显示状态和排列顺序。Photoshop、团片协作等按钮仍会根据组件是否可用自动隐藏。</p><ProjectToolbarSettingsEditor value={draft.projectToolbar} onChange={projectToolbar => update('projectToolbar', projectToolbar)}/></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">角色生日</h4><label className="settings-check"><input type="checkbox" checked={draft.birthdayEnabled} onChange={event => update('birthdayEnabled', event.target.checked)}/>在首页显示角色生日</label></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">恢复默认设置</h4><p className="mt-1 text-sm leading-6 text-slate-500">保留当前工作目录，将其他应用设置恢复为初始值。</p><button type="button" onClick={() => void restoreDefaults()} className="dialog-secondary mt-4 inline-flex items-center gap-2"><RotateCcw size={15}/>恢复默认设置</button></section>
    </>}
    {activeSection === 'privacy' && <PrivacySettings onNotice={onNotice}/>}
    {activeSection === 'storage' && <>
    <section><h4 className="text-sm font-bold text-slate-800">缩略图缓存</h4><p className="mt-1 text-sm text-slate-500">设置图片、RAW 和视频缩略图缓存的容量与位置，并可按时间清理。版本历史预览固定保存在 AppData，不会写入项目目录。</p><div className="mt-4"><MediaCacheSettings config={draft.mediaCache} onChange={mediaCache => update('mediaCache', mediaCache)}/></div></section>
    <InterfaceCacheSettings onNotice={onNotice}/>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">已删除项目数据</h4><label className="settings-check"><input type="checkbox" checked={draft.autoCleanupDeletedProjectData} onChange={event => update('autoCleanupDeletedProjectData', event.target.checked)}/><span><span className="block">是否自动清理已删除项目的数据</span><span className="mt-1 block text-xs leading-5 text-slate-500">默认开启，每天第一次启动软件时检查一次。仅当项目条目已不在系统回收站、原项目路径也不存在时，才会清理数据库记录、项目专属文件和缩略图缓存；无法确认时会保留数据。</span></span></label></section>
    <div className="border-t border-slate-100 pt-6"><LogSettings onNotice={onNotice}/></div>
    </>}
    {activeSection === 'components' && <ComponentSettings components={components} installPath={componentInstallPath} loading={componentsLoading} onRefresh={onRefreshComponents} onComponentsChanged={onComponentsChanged} onNotice={onNotice}/>}
    {activeSection === 'team-retouch' && <>
    <section><h4 className="text-sm font-bold text-slate-800">团片协作</h4><label className="settings-check"><input type="checkbox" checked={teamRetouchSettings.useGpu} onChange={event => updateTeamRetouchSettings({ ...teamRetouchSettings, useGpu: event.target.checked })}/><span><span className="block">优先使用 GPU 进行全身人物检测</span><span className="mt-1 block text-xs leading-5 text-slate-500">关闭时固定使用 CPU；开启后若显卡不支持或运行失败，基础检测会自动回退 CPU。</span></span></label></section>
    <div className="border-t border-slate-100 pt-6"><TeamRetouchEngineSettings component={teamRetouchComponent} onRefresh={onRefreshComponents} onNotice={onNotice}/></div>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">默认识别模式</h4><p className="mt-1 text-xs leading-5 text-slate-500">“团片协作”界面仍可为单次任务临时切换。高级模式不可用时，只有“自动”会安全降级。</p><div className="mt-3 grid gap-3 md:grid-cols-3">{([
      ['auto', '自动（推荐）', '高级可用时使用高级方案，否则使用基础方案完成任务。'],
      ['basic', '基础模式', '固定使用 RTMDet，不启动 WSL，速度快且资源占用较低。'],
      ['advanced', '高级模式', '必须使用 PairDETR + SAM2；不可用时停止并提示修复。'],
    ] as const).map(([mode, label, description]) => <label key={mode} className={`cursor-pointer rounded-xl border p-4 transition ${teamRetouchSettings.backendMode === mode ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'} ${mode === 'advanced' && !teamRetouchComponent?.advancedAvailable ? 'opacity-60' : ''}`}><input type="radio" name="team-retouch-backend-mode" value={mode} checked={teamRetouchSettings.backendMode === mode} disabled={mode === 'advanced' && !teamRetouchComponent?.advancedAvailable} onChange={() => updateTeamRetouchSettings({ ...teamRetouchSettings, backendMode: mode })} className="mr-2"/><span className="font-bold text-slate-800">{label}</span><span className="mt-2 block text-xs leading-5 text-slate-500">{description}</span></label>)}</div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">人物超过 4000 像素时</h4><p className="mt-1 text-xs leading-5 text-slate-500">通常手机修图软件能导出的画质长边不超过 4000 像素。相邻人物只有在脸到肩膀区域都能完整放入时才会合并，放不下会自动拆分为更多工作图。</p><div className="mt-3 grid gap-3 md:grid-cols-2"><label className={`cursor-pointer rounded-xl border p-4 transition ${teamRetouchSettings.oversizeCropMode === 'face-centered' ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}><input type="radio" name="oversize-crop-mode" value="face-centered" checked={teamRetouchSettings.oversizeCropMode === 'face-centered'} onChange={() => updateTeamRetouchSettings({ ...teamRetouchSettings, oversizeCropMode: 'face-centered' })} className="mr-2"/><span className="font-bold text-slate-800">保持 4000 像素（推荐）</span><span className="mt-2 block text-xs leading-5 text-slate-500">优先完整保留每个人的脸到肩膀，并在原图允许时将工作图长边扩展到 4000 像素；一张装不下会自动拆分。</span></label><label className={`cursor-pointer rounded-xl border p-4 transition ${teamRetouchSettings.oversizeCropMode === 'expand' ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}><input type="radio" name="oversize-crop-mode" value="expand" checked={teamRetouchSettings.oversizeCropMode === 'expand'} onChange={() => updateTeamRetouchSettings({ ...teamRetouchSettings, oversizeCropMode: 'expand' })} className="mr-2"/><span className="font-bold text-slate-800">扩大裁剪，保留完整人物</span><span className="mt-2 block text-xs leading-5 text-slate-500">工作图可以超过 4000 像素，完整保留人物，但可能会使部分手机后期软件无法导出原尺寸而影响成图画质。</span></label></div></section>
    </>}
    {activeSection === 'inspiration-library' && <>
    <section><h4 className="text-sm font-bold text-slate-800">灵感库</h4><p className="mt-1 text-sm leading-6 text-slate-500">灵感浏览、项目策划汇聚和 Office 图片提取均为主程序内置功能。</p></section>
    <section className="border-t border-slate-100 pt-6"><label className="form-label">灵感库文件夹</label><WorkspaceFolderPicker value={inspirationLibrarySettings.rootPath} onChange={rootPath => void updateInspirationLibraryRoot(rootPath)}/><p className="mt-2 text-xs leading-5 text-slate-500">选择后立即保存。灵感库页面会直接浏览这个文件夹。</p></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">项目策划文件夹</h4><label className="settings-check"><input type="checkbox" checked={draft.createPlanningFolder} onChange={event => update('createPlanningFolder', event.target.checked)}/><span><span className="block">新建项目时自动创建“策划”文件夹</span><span className="mt-1 block text-xs leading-5 text-slate-500">默认开启。关闭后只创建项目根目录，不会影响已有项目。</span></span></label></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">Office 图片提取</h4><p className="mt-2 text-sm leading-6 text-slate-500">在项目或灵感库的文件浏览器中右键 Word、PowerPoint 或 Excel 文档并选择“提取图片”。图片会保存到文档同目录的“文档名_media”文件夹；重名时自动追加编号，不覆盖已有内容。</p></section>
    </>}
    {activeSection === 'import' && <>
    <section><h4 className="text-sm font-bold text-slate-800">从 SD 卡导入</h4><label className="settings-check"><input type="checkbox" checked={draft.smartImport.autoStart} onChange={event => update('smartImport', { ...draft.smartImport, autoStart: event.target.checked })}/>应用启动时自动读取 SD 卡</label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.splitLargeFiles} onChange={event => update('smartImport', { ...draft.smartImport, splitLargeFiles: event.target.checked })}/><span><span className="block">超过 4GB 的视频自动分割</span><span className="mt-1 block text-xs leading-5 text-slate-500">用于兼容部分老旧 U 盘的 FAT32 单文件大小限制，以及某些云盘的单文件上传限制。</span></span></label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.generateVideoPreview} onChange={event => update('smartImport', { ...draft.smartImport, generateVideoPreview: event.target.checked })}/><span><span className="block">生成视频预览</span><span className="mt-1 block text-xs leading-5 text-slate-500">为导入到“mov”的大型视频生成 H.264 文件，储存在“mov_预览”并作为软件内快速播放源。关闭后不会在浏览时临时转码这些导入视频；其他普通视频仍可照常预览。</span></span></label><fieldset disabled={!draft.smartImport.generateVideoPreview} className={`ml-7 mt-3 max-w-xl ${draft.smartImport.generateVideoPreview ? '' : 'opacity-50'}`}><legend className="text-xs font-bold text-slate-700">预览质量</legend><div className="mt-3 grid gap-3 md:grid-cols-2">{([
      ['medium', '中（默认 · 约 4 Mbps）', '保持当前预览质量，生成速度和文件大小较均衡。'],
      ['high', '高（约 10 Mbps）', '接近 Adobe 匹配源高比特率，画面细节更好，文件也会明显增大。'],
    ] as const).map(([quality, label, description]) => <label key={quality} className={`rounded-xl border p-4 transition ${draft.smartImport.generateVideoPreview ? 'cursor-pointer' : 'cursor-not-allowed'} ${draft.smartImport.videoPreviewQuality === quality ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}><input type="radio" name="video-preview-quality" value={quality} checked={draft.smartImport.videoPreviewQuality === quality} onChange={() => update('smartImport', { ...draft.smartImport, videoPreviewQuality: quality })} className="mr-2"/><span className="font-bold text-slate-800">{label}</span><span className="mt-2 block text-xs leading-5 text-slate-500">{description}</span></label>)}</div></fieldset></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">导入设置</h4><label className="settings-check"><input type="checkbox" checked={draft.fileImport.preserveOriginal} onChange={event => update('fileImport', { preserveOriginal: event.target.checked })}/><span><span className="block">导入后保留原始文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">开启此项后导入的文件会保留源文件。这可能会导致大量的文件重复。</span></span></label><label className="settings-check"><input type="checkbox" checked={draft.brollImport.splitLargeFiles} onChange={event => update('brollImport', { ...draft.brollImport, splitLargeFiles: event.target.checked })}/><span><span className="block">花絮视频超过 4GB 时自动分割</span><span className="mt-1 block text-xs leading-5 text-slate-500">用于兼容 FAT32 和部分云盘的单文件大小限制。</span></span></label></section>
    </>}
    {activeSection === 'about' && <AboutSettings/>}
  </div></section>;
};

const PrivacySettings = ({ onNotice }: { onNotice: (message: string, duration?: number) => void }) => {
  const appDialog = useAppDialog();
  const [state, setState] = useState<PrivacyConsentState | null>(null);
  useEffect(() => { void window.electronAPI.getPrivacyConsentState().then(setState); }, []);
  const open = async (id: LegalDocumentId) => {
    const result = await window.electronAPI.openLegalDocument(id);
    if (!result.success) onNotice(`打开法律文件失败：${result.error || '未知错误'}`, 5000);
  };
  const setFaceConsent = async (granted: boolean) => {
    if (granted && !await appDialog.confirm({
      title: '单独同意处理人脸信息',
      message: '人物身份识别会在本机提取人脸身份特征和身体外观特征，用于跨照片生成同一人物候选分组。',
      detail: '请确认已取得被摄者或其监护人的合法授权。照片和特征不会因该功能自动上传；自动结果必须人工确认。',
      confirmLabel: '单独同意',
      cancelLabel: '暂不启用',
    })) return;
    if (!granted && !await appDialog.confirm({
      title: '撤回人脸识别同意吗？',
      message: '撤回后将停止新的跨照片人物身份识别。已有项目中的人物名称、候选分组和工作图不会自动删除。',
      detail: '如需删除已有结果，请在相应项目中删除人物身份或清理项目数据。',
      confirmLabel: '撤回同意',
      cancelLabel: '保留',
      tone: 'danger',
    })) return;
    const result = await window.electronAPI.savePrivacyConsent({ faceRecognitionGranted: granted });
    if (!result.success || !result.state) { onNotice(`保存人脸识别选择失败：${result.error || '未知错误'}`, 5000); return; }
    setState(result.state);
    onNotice(granted ? '已单独同意本地人脸身份识别' : '已撤回人脸身份识别同意');
  };
  const clearTelemetry = async () => {
    if (!await appDialog.confirm({
      title: '重置本机统计标识吗？',
      message: '将删除尚未发送的统计与崩溃队列，并生成新的随机安装ID。已经发送到服务器的数据不会因此自动删除。',
      confirmLabel: '清除并重置',
      cancelLabel: '取消',
      tone: 'danger',
    })) return;
    const result = await window.electronAPI.clearTelemetryLocalData();
    onNotice(result.success ? '本机统计标识和待发送队列已重置' : `清理失败：${result.error || '未知错误'}`, 5000);
  };
  const leaveInternalBeta = async () => {
    if (!await appDialog.confirm({
      title: '撤回同意并退出内测吗？',
      message: '撤回后，照片流将停止发送新的使用统计和崩溃报告并立即退出。下次启动仍需重新同意才能进入内测。',
      detail: '此操作会清除本机待发送队列并重置随机安装ID，但不会自动删除服务器已经接收的数据；如需删除请通过隐私政策中的联系方式提出请求。',
      confirmLabel: '撤回并退出',
      cancelLabel: '继续参加内测',
      tone: 'danger',
    })) return;
    await window.electronAPI.savePrivacyConsent({ revokeCore: true });
    await window.electronAPI.clearTelemetryLocalData();
    window.electronAPI.closeWindow();
  };
  const legalDocuments: Array<[LegalDocumentId, string, string]> = [
    ['privacy', '隐私政策', '数据处理、保存期限和用户权利'],
    ['terms', '用户协议', '内测资格、软件许可和使用责任'],
    ['face', '人脸信息处理规则', '敏感个人信息的单独说明'],
    ['information-list', '个人信息清单', '逐项列明本地和联网数据'],
    ['third-parties', '第三方服务清单', '腾讯云及主动访问的外部链接'],
    ['permissions', '权限与文件访问说明', '工作目录、磁盘和外部程序'],
    ['children', '儿童个人信息规则', '不满十四周岁被摄者信息'],
    ['customer-data', '客户数据处理条款', '影楼和摄影工作室使用规则'],
    ['open-source', '开源许可证说明', '第三方软件和模型许可'],
  ];
  return <div className="space-y-7">
    <section><div className="flex items-center gap-2"><ShieldCheck size={19} className="text-blue-600"/><h4 className="text-base font-bold text-slate-800">内测数据要求</h4></div><p className="mt-2 text-sm leading-6 text-slate-500">当前内测资格要求使用统计和崩溃报告始终开启。不同意时软件不会进入主界面。统计使用的是可区分安装实例的随机ID，属于去标识化数据，不应理解为绝对匿名。</p><label className="settings-check cursor-not-allowed"><input type="checkbox" checked disabled/><span><span className="block">发送使用统计（内测必须）</span><span className="mt-1 block text-xs leading-5 text-slate-500">随机安装ID、会话ID、版本、平台、功能代号、时间及时区、数量区间。</span></span></label><label className="settings-check cursor-not-allowed"><input type="checkbox" checked disabled/><span><span className="block">发送崩溃报告（内测必须）</span><span className="mt-1 block text-xs leading-5 text-slate-500">错误类型、调用栈和脱敏后的错误日志尾部。</span></span></label><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void clearTelemetry()} className="dialog-secondary inline-flex items-center gap-2"><Trash2 size={14}/>重置本机统计标识与队列</button><button type="button" onClick={() => void leaveInternalBeta()} className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50">撤回同意并退出内测</button></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-base font-bold text-slate-800">人脸身份识别</h4><p className="mt-1 text-sm leading-6 text-slate-500">普通人物检测、裁图和手工标记无需启用跨照片身份识别。首次自动识别同一人物时仍会再次显示单独确认。</p><label className="settings-check"><input type="checkbox" checked={state?.faceRecognitionGranted === true} disabled={!state} onChange={event => void setFaceConsent(event.target.checked)}/><span><span className="block">允许在本机处理人脸特征以识别同一人物</span><span className="mt-1 block text-xs leading-5 text-slate-500">可随时撤回；撤回不会自动删除已经生成的项目数据。</span></span></label><button type="button" onClick={() => void open('face')} className="text-xs font-bold text-blue-600 hover:underline">查看《人脸信息处理规则》</button></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-base font-bold text-slate-800">法律与数据说明</h4><div className="mt-4 grid gap-3 md:grid-cols-2">{legalDocuments.map(([id, label, description]) => <button type="button" key={id} onClick={() => void open(id)} className="rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-blue-300 hover:bg-blue-50"><span className="flex items-center justify-between gap-2 font-bold text-slate-800">{label}<ExternalLink size={14} className="text-blue-500"/></span><span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span></button>)}</div></section>
    <section className="border-t border-slate-100 pt-6 text-xs leading-5 text-slate-500"><p>当前隐私政策版本：{state?.currentPrivacyNoticeVersion || '读取中'}</p><p>当前用户协议版本：{state?.currentTermsVersion || '读取中'}</p><p>联系方式：akiyastudio@qq.com</p></section>
  </div>;
};

const AboutSettings = () => {
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'latest' | 'error'>('idle');
  const checkForUpdates = async () => {
    setUpdateStatus('checking');
    const result = await window.electronAPI.checkForUpdates();
    setUpdateStatus(result.success && !result.updateAvailable ? 'latest' : result.success ? 'idle' : 'error');
  };
  const openExternal = (url: string) => window.electronAPI.openExternal(url);

  return <div className="space-y-7 text-sm leading-6 text-slate-600">
    <section>
      <p className="text-lg font-bold text-slate-800">by秋也寻</p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <p className="font-medium text-blue-600">版本 26.7.29</p>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-bold leading-5 text-amber-700">内测版</span>
        <button type="button" onClick={() => void checkForUpdates()} disabled={updateStatus === 'checking'} className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-bold leading-5 text-blue-700 transition hover:bg-blue-100 disabled:cursor-wait disabled:opacity-60">{updateStatus === 'checking' ? '正在检查…' : '检查更新'}</button>
        {updateStatus === 'latest' && <span className="text-xs text-emerald-600">已是最新版本</span>}
        {updateStatus === 'error' && <span className="text-xs text-red-500">检查失败，请稍后重试</span>}
      </div>
    </section>

    <section className="rounded-xl border border-blue-100 bg-blue-50 p-4">
      <h4 className="text-base font-bold text-slate-800">项目与联系</h4>
      <div className="mt-3 flex flex-col items-start gap-2 leading-5">
        <button type="button" onClick={() => openExternal('https://github.com/akiyastudio/photoflow')} className="inline-flex items-center gap-1.5 break-all text-left font-medium text-blue-600 hover:underline">https://github.com/akiyastudio/photoflow <ExternalLink size={13} className="shrink-0"/></button>
        <button type="button" onClick={() => openExternal('mailto:akiyastudio@qq.com')} className="inline-flex items-center gap-1.5 font-medium text-blue-600 hover:underline">akiyastudio@qq.com <ExternalLink size={13}/></button>
      </div>
    </section>

    <section className="border-t border-slate-200 pt-5"><h4 className="text-base font-bold text-slate-800">使用提示</h4><p className="mt-1">软件尚未经过充分测试。使用前请备份重要数据；作者不对使用本软件造成的损失负责。</p></section>

    <section className="border-t border-slate-200 pt-6">
      <div className="flex items-center gap-2"><Scale size={18} className="text-blue-600"/><h4 className="text-base font-bold text-slate-800">开源许可</h4></div>
      <p className="mt-2 text-xs leading-5 text-slate-500">这里列出随主程序、可选组件和增强包分发的主要第三方软件与模型。许可证归其各自权利人所有；非商业使用也必须遵守相应条款。</p>
      <h5 className="mt-5 font-bold text-slate-800">模型与权重</h5>
      <p className="mt-1 text-xs leading-5 text-slate-500">SHA-256 对应软件实际随附文件；下载地址指向上游原始权重时，其哈希可能与软件转换后的 ONNX 不同。</p>
      <div className="mt-4 space-y-4">
        {FORMAL_MODEL_LICENSES.map(model => <article key={model.bundledFile} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h5 className="font-bold text-slate-900">{model.name}</h5><p className="mt-0.5 text-xs text-slate-500">{model.purpose}</p></div><span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600">{model.license}</span></div>
          <dl className="mt-4 grid gap-x-5 gap-y-3 text-xs md:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="font-bold text-slate-500">随附文件</dt><dd className="break-all font-mono text-slate-700">{model.bundledFile}</dd>
            <dt className="font-bold text-slate-500">版本</dt><dd className="text-slate-700">{model.version}</dd>
            <dt className="font-bold text-slate-500">SHA-256</dt><dd className="break-all font-mono text-slate-700">{model.sha256}</dd>
            <dt className="font-bold text-slate-500">下载说明</dt><dd className="text-slate-700">{model.downloadNote}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => openExternal(model.sourceUrl)} className="dialog-secondary inline-flex items-center gap-1.5 text-xs">来源 <ExternalLink size={13}/></button>
            <button type="button" onClick={() => openExternal(model.downloadUrl)} className="dialog-secondary inline-flex items-center gap-1.5 text-xs">下载 <ExternalLink size={13}/></button>
          </div>
          <details className="mt-4 rounded-lg border border-slate-200 bg-white">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-bold text-slate-700">许可证全文</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-slate-200 p-3 font-mono text-[11px] leading-5 text-slate-600">{model.licenseText}</pre>
          </details>
        </article>)}
      </div>

      <h5 className="mt-7 font-bold text-slate-800">第三方软件与运行库</h5>
      <p className="mt-1 text-xs leading-5 text-slate-500">构建工具若没有进入发行包则不在此列。Chromium 和高级 WSL 镜像还包含大量传递依赖，发布包应同时保留其机器可读的完整第三方声明。</p>
      <div className="mt-4 space-y-5">
        {(['主程序', '本地组件', '人物检测增强包'] as const).map(group => <section key={group}>
          <h6 className="text-xs font-bold text-slate-500">{group}</h6>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {THIRD_PARTY_SOFTWARE_LICENSES.filter(item => item.group === group).map(item => <article key={`${item.group}-${item.name}`} className={`rounded-xl border p-4 ${item.attention ? 'border-amber-200 bg-amber-50/50' : 'border-slate-200 bg-slate-50'}`}>
              <div className="flex flex-wrap items-start justify-between gap-2"><div><h6 className="font-bold text-slate-900">{item.name}</h6><p className="mt-0.5 text-xs text-slate-500">{item.version} · {item.purpose}</p></div><span className={`rounded-full border bg-white px-2.5 py-1 text-[11px] font-bold ${item.attention ? 'border-amber-200 text-amber-700' : 'border-slate-200 text-slate-600'}`}>{item.license}</span></div>
              {item.note && <p className={`mt-3 text-xs leading-5 ${item.attention ? 'text-amber-800' : 'text-slate-600'}`}>{item.note}</p>}
              <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => openExternal(item.sourceUrl)} className="dialog-secondary inline-flex items-center gap-1.5 text-xs">来源 <ExternalLink size={13}/></button><button type="button" onClick={() => openExternal(item.licenseUrl)} className="dialog-secondary inline-flex items-center gap-1.5 text-xs">许可证 <ExternalLink size={13}/></button></div>
            </article>)}
          </div>
        </section>)}
      </div>
    </section>
  </div>;
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
