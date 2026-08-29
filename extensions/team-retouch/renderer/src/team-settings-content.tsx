import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Loader2, RotateCcw, Wrench } from 'lucide-react';
import { useAppDialog } from './legacy/legacy-dialog-context';
import { durableRpc, rpc } from './sdk';
import { advancedEnvironmentPresentation, createLatestRequestGuard, runNotifiedAction, type TeamSettings, type TeamSettingsPatch } from './team-settings-model';

type Json = Record<string, unknown>;
export type { TeamSettings } from './team-settings-model';
const assertSuccess = (value: Json, fallback: string) => { if (value?.success === false) throw new Error(typeof value.error === 'string' ? value.error : fallback); return value; };

const SettingsGroup = ({ title, children }: { title: string; children: ReactNode }) => <section className="pf-settings-group">
  <h2 className="pf-settings-group-title">{title}</h2>
  <div className="pf-settings-card">{children}</div>
</section>;

const SettingsRow = ({ title, description, children, align = 'center' }: { title: string; description: string; children: ReactNode; align?: 'center' | 'start' }) => <div className="pf-settings-row" data-settings-row data-align={align}>
  <div className="pf-settings-copy"><h3 className="pf-settings-row-title">{title}</h3><p className="pf-settings-description">{description}</p></div>
  <div className="pf-settings-control">{children}</div>
</div>;

export const TeamAdvancedSettingsContent = ({ notice }: { notice: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void }) => {
  const appDialog = useAppDialog();
  const [busy, setBusy] = useState('');
  const [environment, setEnvironment] = useState<Json>();
  const [environmentLoading, setEnvironmentLoading] = useState(true);
  const [environmentFailed, setEnvironmentFailed] = useState(false);
  const statusGuardRef = useRef(createLatestRequestGuard());
  const refreshEnvironment = useCallback(async () => {
    const generation = statusGuardRef.current.begin();
    setEnvironmentLoading(true);
    setEnvironmentFailed(false);
    try {
      const status = await rpc<Json>('team.advanced.status.v1');
      if (statusGuardRef.current.isCurrent(generation)) setEnvironment(status);
    } catch {
      if (statusGuardRef.current.isCurrent(generation)) setEnvironmentFailed(true);
    } finally {
      if (statusGuardRef.current.isCurrent(generation)) setEnvironmentLoading(false);
    }
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
  const applyLifecycleResult = (result: Json) => {
    statusGuardRef.current.invalidate();
    setEnvironment(result);
    setEnvironmentFailed(false);
    setEnvironmentLoading(false);
  };
  const advanced = advancedEnvironmentPresentation(environment, environmentLoading, environmentFailed);
  const developmentRuntime = environment?.runtimeSource === 'development';
  const canManageEnvironment = !environmentLoading && !environmentFailed && !developmentRuntime;
  return <>
    <SettingsGroup title="人物检测增强版">
      <SettingsRow title="PairDETR + SAM 2.1" description="改善多人、遮挡和精细分割效果。" align="start">
        <div className="team-settings-status" aria-live="polite">
          <span className="team-settings-badge pf-status" data-tone={advanced.tone}>{advanced.state === 'loading' && <Loader2 size={13} className="animate-spin"/>}{advanced.label}</span>
          <div className="team-settings-banner pf-banner" data-tone={advanced.tone === 'danger' ? 'danger' : advanced.tone === 'warning' ? 'warning' : undefined}>{(advanced.state === 'error' || advanced.state === 'repair-needed' || advanced.state === 'unavailable') && <AlertCircle size={15}/>}<span>{advanced.description}</span></div>
          <div className="team-settings-actions">
            {(advanced.state === 'error' || advanced.state === 'unavailable') && <button type="button" className="pf-button inline-flex items-center gap-2" onClick={() => void refreshEnvironment()} disabled={Boolean(busy)}><RotateCcw size={14}/>重新检查</button>}
            {canManageEnvironment && <button type="button" className="pf-button inline-flex items-center gap-2" onClick={() => void run('检查安装条件', async () => { applyLifecycleResult(assertSuccess(await durableRpc<Json>('team.advanced.preflight.v1'), '安装条件检查失败')); })} disabled={Boolean(busy)}><RotateCcw size={14}/>检查条件</button>}
            {canManageEnvironment && <button type="button" className="pf-button pf-button-primary inline-flex items-center gap-2" onClick={() => void run('安装或修复增强版', async () => { applyLifecycleResult(assertSuccess(await durableRpc<Json>('team.advanced.install.v1', { repair: true }), '安装失败')); })} disabled={Boolean(busy)}><Wrench size={14}/>{busy === '安装或修复增强版' ? '正在处理…' : '安装 / 修复'}</button>}
            {canManageEnvironment && <button type="button" className="pf-button pf-button-danger" onClick={() => void run('卸载增强版', async () => { if (!await appDialog.confirm({ title: '卸载人物检测增强版吗？', message: '将删除 PairDETR、SAM 2.1 和独立运行环境；基础检测和身份识别不受影响。', confirmLabel: '卸载增强版', tone: 'danger' })) return false; assertSuccess(await durableRpc<Json>('team.advanced.uninstall.v1'), '卸载失败'); applyLifecycleResult({ success: true, state: 'not-installed', installed: false, runtimeSource: 'packaged' }); return true; })} disabled={Boolean(busy)}>卸载</button>}
          </div>
        </div>
      </SettingsRow>
      <SettingsRow title="安装条件" description="Windows x64、WSL 2、支持 WSL CUDA 的 NVIDIA 显卡与驱动，以及至少 35 GB 可用空间。建议至少 8 GB 显存和 16 GB 系统内存。"><span className="team-settings-badge pf-status">离线安装</span></SettingsRow>
    </SettingsGroup>
  </>;
};

export const TeamSettingsContent = ({ value, patch, notice }: { value: TeamSettings; patch: (value: TeamSettingsPatch) => void | Promise<void>; notice: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void }) => {
  const save = (next: TeamSettingsPatch) => { void Promise.resolve(patch(next)).catch(() => undefined); };
  return <div data-settings-visual-contract="official-host-v1">
    <SettingsGroup title="处理偏好">
      <SettingsRow title="优先使用 GPU" description="显卡不支持或运行失败时，基础人物检测会自动回退 CPU。"><label className="flex justify-end"><span className="sr-only">优先使用 GPU</span><input type="checkbox" className="h-4 w-4 accent-blue-600" aria-label="优先使用 GPU" checked={value.useGpu} onChange={() => save({ useGpu: !value.useGpu })}/></label></SettingsRow>
      <SettingsRow title="裁剪方式" description="人物超过 4000 像素时，可限制尺寸或保留完整人物；后者可能超出手机修图软件限制。"><select aria-label="超大人物裁剪方式" className="pf-select pf-settings-field" value={value.oversizeCropMode} onChange={event => save({ oversizeCropMode: event.target.value as TeamSettings['oversizeCropMode'] })}><option value="face-centered">保持 4000 像素</option><option value="expand">扩大裁剪，保留完整人物</option></select></SettingsRow>
    </SettingsGroup>
    <TeamAdvancedSettingsContent notice={notice}/>
  </div>;
};
