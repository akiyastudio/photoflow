import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, FolderOpen, Loader2, PackageCheck, RotateCcw, ShieldCheck, Wrench } from 'lucide-react';
import { useAppDialog } from './legacy/legacy-dialog-context';
import { durableRpc, notify, rpc } from './sdk';
import { TeamLicenseContent } from './team-license-content';
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
  const [environmentChecked, setEnvironmentChecked] = useState(false);
  const [packageReady, setPackageReady] = useState(false);
  const statusGuardRef = useRef(createLatestRequestGuard());
  const refreshEnvironment = useCallback(async () => {
    const generation = statusGuardRef.current.begin();
    setEnvironmentLoading(true);
    setEnvironmentFailed(false);
    try {
      const status = await rpc<Json>('team.advanced.status.v1');
      if (statusGuardRef.current.isCurrent(generation)) {
        setEnvironment(status);
        if (status.advancedAvailable === true || status.state === 'ready') { setEnvironmentChecked(true); setPackageReady(true); }
      }
    } catch {
      if (statusGuardRef.current.isCurrent(generation)) setEnvironmentFailed(true);
    } finally {
      if (statusGuardRef.current.isCurrent(generation)) setEnvironmentLoading(false);
    }
  }, []);
  useEffect(() => {
    const statusGuard = statusGuardRef.current;
    void refreshEnvironment();
    const offActivate = window.photoFlowComponent.onActivate(() => { void refreshEnvironment(); });
    return () => { statusGuard.invalidate(); offActivate(); };
  }, [refreshEnvironment]);
  const run = async (label: string, action: () => Promise<boolean | void>) => {
    if (busy) return;
    setBusy(label);
    try { await runNotifiedAction(label, action, notice); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error', { dedupeKey: 'team-advanced-setup-error' }); }
    finally { setBusy(''); }
  };
  const applyLifecycleResult = (result: Json) => {
    statusGuardRef.current.invalidate();
    setEnvironment(result);
    setEnvironmentFailed(false);
    setEnvironmentLoading(false);
  };
  const advanced = advancedEnvironmentPresentation(environment, environmentLoading, environmentFailed);
  const buildWithoutAdvanced = environment?.errorCategory === 'advanced-package-not-in-build';
  const canManageEnvironment = !environmentLoading && !buildWithoutAdvanced;
  const installed = advanced.state === 'ready';
  const uninstall = () => run('卸载增强版', async () => {
    if (!await appDialog.confirm({ title: '卸载人物检测增强版吗？', message: '将删除 PairDETR、SAM 2.1 和独立运行环境；基础检测和身份识别不受影响。', confirmLabel: '卸载增强版', tone: 'danger' })) return false;
    assertSuccess(await durableRpc<Json>('team.advanced.uninstall.v1'), '卸载失败');
    setEnvironmentChecked(false); setPackageReady(false);
    applyLifecycleResult({ success: true, state: 'not-installed', installed: false, runtimeSource: environment?.runtimeSource || 'packaged' });
    return true;
  });
  return <>
    <SettingsGroup title="人物检测增强版">
      <SettingsRow title="PairDETR + SAM 2.1" description="改善多人、遮挡和精细分割效果。" align="start">
        <div className="team-settings-status" aria-live="polite">
          <span className="team-settings-badge pf-status" data-tone={advanced.tone}>{advanced.state === 'loading' && <Loader2 size={13} className="animate-spin"/>}{advanced.label}</span>
          <div className="team-settings-banner pf-banner" data-tone={advanced.tone === 'danger' ? 'danger' : advanced.tone === 'warning' ? 'warning' : undefined}>{(advanced.state === 'error' || advanced.state === 'repair-needed' || advanced.state === 'unavailable') && <AlertCircle size={15}/>}<span>{advanced.description}</span></div>
          <div className="team-settings-actions">
            {(advanced.state === 'error' || advanced.state === 'unavailable') && <button type="button" className="pf-button inline-flex items-center gap-2" onClick={() => void refreshEnvironment()} disabled={Boolean(busy)}><RotateCcw size={14}/>重新检查</button>}
          </div>
        </div>
      </SettingsRow>
      <SettingsRow title="增强版安装向导" description="按顺序完成检查、放置安装包和安装；开发版与正式版使用相同流程。" align="start">
        <div className="team-settings-status">
          {buildWithoutAdvanced && <p className="pf-settings-description">当前插件不支持此高级环境接口，请先更新团片协作基础插件。</p>}
          {canManageEnvironment && installed ? <div className="team-setup-complete"><CheckCircle2 size={20}/><div><strong>增强版已安装</strong><p>PairDETR 与 SAM 2.1 已可用。</p></div><button type="button" className="pf-button pf-button-danger" onClick={() => void uninstall()} disabled={Boolean(busy)}>卸载增强版</button></div> : canManageEnvironment && <ol className="team-setup-flow">
            <li data-state={environmentChecked ? 'done' : 'current'}><span className="team-setup-number">1</span><div><strong>检查安装环境</strong><p>验证 Windows x64、WSL 2、NVIDIA CUDA 和磁盘空间。</p><button type="button" className="pf-button pf-button-primary inline-flex items-center gap-2" onClick={() => void run('检查安装环境', async () => { assertSuccess(await durableRpc<Json>('team.advanced.preflight.v1'), '安装环境检查失败'); setEnvironmentChecked(true); })} disabled={Boolean(busy)}>{busy === '检查安装环境' ? <Loader2 size={14} className="animate-spin"/> : <ShieldCheck size={14}/>} {environmentChecked ? '重新检查环境' : '检查安装环境'}</button></div></li>
            <li data-state={packageReady ? 'done' : environmentChecked ? 'current' : 'waiting'}><span className="team-setup-number">2</span><div><strong>放入并检测高级版安装包</strong><p>打开专用目录，放入原始 ZIP，无需解压；随后检测版本与完整性。</p><div className="team-settings-actions justify-start"><button type="button" className="pf-button inline-flex items-center gap-2" onClick={() => void run('打开高级版安装目录', async () => { await window.photoFlowComponent.dialog({ kind: 'openComponentDataDirectory', relativePath: 'advanced/packages' }); })} disabled={Boolean(busy) || !environmentChecked}><FolderOpen size={14}/>打开高级版安装目录</button><button type="button" className="pf-button inline-flex items-center gap-2" onClick={() => void run('检测高级版安装包', async () => { assertSuccess(await durableRpc<Json>('team.advanced.package.verify.v1'), '高级版安装包检测失败'); setPackageReady(true); })} disabled={Boolean(busy) || !environmentChecked}>{busy === '检测高级版安装包' ? <Loader2 size={14} className="animate-spin"/> : <PackageCheck size={14}/>} {packageReady ? '重新检测安装包' : '检测安装包'}</button></div></div></li>
            <li data-state={packageReady ? 'current' : 'waiting'}><span className="team-setup-number">3</span><div><strong>安装增强版</strong><p>检测通过后即可安装；完成后页面只显示已安装状态与卸载按钮。</p><button type="button" className="pf-button pf-button-primary inline-flex items-center gap-2" onClick={() => void run('安装增强版', async () => { const result = assertSuccess(await durableRpc<Json>('team.advanced.install.v1'), '安装失败'); setEnvironmentChecked(true); setPackageReady(true); applyLifecycleResult(result); })} disabled={Boolean(busy) || !packageReady}><Wrench size={14}/>{busy === '安装增强版' ? '正在安装…' : '安装增强版'}</button></div></li>
          </ol>}
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
      <SettingsRow title="工作图分组" description="自动合组会把相邻人物安排在同一张工作图；每人一张会为每个目标人物单独生成工作图，只合并该人物的修改。靠近或遮挡的人物仍可能出现在裁剪画面中。此设置在下次检测或重新检测时生效，已有工作图保持原样。"><select aria-label="工作图分组" className="pf-select pf-settings-field" value={value.workTileMode} onChange={event => save({ workTileMode: event.target.value as TeamSettings['workTileMode'] })}><option value="grouped">自动合组</option><option value="per-person">每人一张</option></select></SettingsRow>
      <SettingsRow title="优先使用 GPU" description="显卡不支持或运行失败时，基础人物检测会自动回退 CPU。"><label className="flex justify-end"><span className="sr-only">优先使用 GPU</span><input type="checkbox" className="h-4 w-4 accent-blue-600" aria-label="优先使用 GPU" checked={value.useGpu} onChange={() => save({ useGpu: !value.useGpu })}/></label></SettingsRow>
      <SettingsRow title="裁剪方式" description="人物超过 4000 像素时，可限制尺寸或保留完整人物；后者可能超出手机修图软件限制。"><select aria-label="超大人物裁剪方式" className="pf-select pf-settings-field" value={value.oversizeCropMode} onChange={event => save({ oversizeCropMode: event.target.value as TeamSettings['oversizeCropMode'] })}><option value="face-centered">保持 4000 像素</option><option value="expand">扩大裁剪，保留完整人物</option></select></SettingsRow>
    </SettingsGroup>
    <TeamAdvancedSettingsContent notice={notice}/>
    <TeamLicenseContent/>
  </div>;
};
