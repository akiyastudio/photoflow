import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Wrench } from 'lucide-react';
import { useAppDialog } from './legacy/legacy-dialog-context';
import { rpc } from './sdk';
import { createLatestRequestGuard, runNotifiedAction, type TeamSettings, type TeamSettingsPatch } from './team-settings-model';

type Json = Record<string, any>;
export type { TeamSettings } from './team-settings-model';
const assertSuccess = (value: Json, fallback: string) => { if (value?.success === false) throw new Error(value.error || fallback); return value; };

export const TeamSettingsContent = ({ value, patch, notice }: { value: TeamSettings; patch: (value: TeamSettingsPatch) => void | Promise<void>; notice: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void }) => {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState('');
  const [environment, setEnvironment] = useState<Json>();
  const statusGuardRef = useRef(createLatestRequestGuard());
  const refreshEnvironment = useCallback(async () => {
    const generation = statusGuardRef.current.begin();
    try { const status = await rpc<Json>('team.advanced.status.v1'); if (statusGuardRef.current.isCurrent(generation)) setEnvironment(status); }
    catch { /* status remains best-effort; lifecycle buttons stay available */ }
  }, []);
  useEffect(() => {
    void refreshEnvironment();
    const offActivate = window.photoFlowComponent.onActivate(() => { void refreshEnvironment(); });
    return () => { statusGuardRef.current.invalidate(); offActivate(); };
  }, [refreshEnvironment]);
  const run = async (label: string, action: () => Promise<boolean | void>) => {
    if (busy) return;
    setBusy(label);
    try { await runNotifiedAction(label, action, notice); }
    catch (error) { notice(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(''); }
  };
  const save = (next: TeamSettingsPatch) => { void Promise.resolve(patch(next)).catch(() => undefined); };
  return <div className="space-y-5">
    <section className="team-card pf-card overflow-hidden"><h3 className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-slate-700">处理偏好</h3><div className="flex items-center justify-between gap-5 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">优先使用 GPU</h4><p className="mt-1 text-xs text-slate-500">显卡不支持或运行失败时，基础人物检测会自动回退 CPU。</p></div><button role="switch" aria-label="优先使用 GPU" aria-checked={value.useGpu} className={`relative h-6 w-11 rounded-full ${value.useGpu ? 'bg-blue-600' : 'bg-slate-300'}`} onClick={() => save({ useGpu: !value.useGpu })}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${value.useGpu ? 'left-6' : 'left-1'}`}/></button></div><div className="flex items-center justify-between gap-5 border-t border-slate-100 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">裁剪方式</h4><p className="mt-1 text-xs text-slate-500">人物超过 4000 像素时，可限制尺寸或保留完整人物；后者可能超出手机修图软件限制。</p></div><select aria-label="超大人物裁剪方式" className="form-input max-w-sm" value={value.oversizeCropMode} onChange={event => save({ oversizeCropMode: event.target.value as TeamSettings['oversizeCropMode'] })}><option value="face-centered">保持 4000 像素</option><option value="expand">扩大裁剪，保留完整人物</option></select></div></section>
    <section className="team-card pf-card overflow-hidden"><h3 className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-slate-700">识别引擎</h3><div className="flex items-start justify-between gap-5 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">基础人物检测</h4><p className="mt-1 text-xs text-slate-500">提供基础人物检测、裁图和分割。</p></div><p className="text-xs font-bold text-emerald-600">可用</p></div><div className="flex items-start justify-between gap-5 border-t border-slate-100 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">人物身份识别</h4><p className="mt-1 text-xs text-slate-500">用于跨照片识别同一人物。支持 CPU；可用显卡会自动加速。</p></div><p className="text-xs font-bold text-emerald-600">可用</p></div></section>
    <section className="team-card pf-card overflow-hidden"><h3 className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-slate-700">人物检测增强版</h3><div className="flex items-start justify-between gap-5 px-4 py-3.5"><div><h4 className="text-sm font-bold text-slate-800">PairDETR + SAM 2.1</h4><p className="mt-1 text-xs text-slate-500">改善多人、遮挡和精细分割效果。</p>{environment && <pre className="mt-3 max-w-xl whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">{environment.message || environment.error || JSON.stringify(environment, null, 2)}</pre>}</div><div className="flex flex-wrap justify-end gap-2"><button className="dialog-secondary inline-flex items-center gap-2" onClick={() => void run('检查安装条件', async () => { statusGuardRef.current.invalidate(); setEnvironment(await rpc<Json>('team.advanced.preflight.v1')); })} disabled={Boolean(busy)}><RotateCcw size={14}/>检查</button><button className="dialog-primary inline-flex items-center gap-2" onClick={() => void run('安装或修复增强版', async () => { statusGuardRef.current.invalidate(); setEnvironment(assertSuccess(await rpc<Json>('team.advanced.install.v1', { repair: true }), '安装失败')); })} disabled={Boolean(busy)}><Wrench size={14}/>安装 / 修复</button><button className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50" onClick={() => void run('卸载增强版', async () => { if (!await appDialog.confirm({ title: '卸载人物检测增强版吗？', message: '将删除 PairDETR、SAM 2.1 和独立运行环境；基础检测和身份识别不受影响。', confirmLabel: '卸载增强版', tone: 'danger' })) return false; statusGuardRef.current.invalidate(); assertSuccess(await rpc<Json>('team.advanced.uninstall.v1'), '卸载失败'); setEnvironment(undefined); return true; })} disabled={Boolean(busy)}>卸载</button></div></div><div className="border-t border-slate-100 px-4 py-3.5"><h4 className="text-sm font-bold text-slate-800">安装条件</h4><p className="mt-1 text-xs leading-5 text-slate-500">Windows x64、WSL 2、支持 WSL CUDA 的 NVIDIA 显卡与驱动，以及至少 35 GB 可用空间。建议至少 8 GB 显存和 16 GB 系统内存。</p></div></section>
  </div>;
};
