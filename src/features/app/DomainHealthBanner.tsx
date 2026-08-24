import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ComponentStatus } from '../../types';
import { legacyComponentIdForDomain } from '../../compatibility/component-domains';

type DomainHealthSnapshot = Awaited<ReturnType<Window['electronAPI']['getDomainHealth']>>;

const DOMAIN_LABELS: Record<string, string> = {
  workspace: '项目目录', 'workspace-maintenance': '工作区维护', 'file-operations': '文件操作',
  'media-background': '媒体索引', 'media-interaction': '媒体浏览', 'media-scan': '媒体扫描',
  'tracking-scan': '版本跟踪', components: '组件数据',
};

export const DomainHealthBanner = ({ components, onNotice }: { components: ComponentStatus[]; onNotice: (message: string, duration?: number) => void }) => {
  const [snapshot, setSnapshot] = useState<DomainHealthSnapshot>({ success: true, domains: [], commands: [] });
  const refresh = useCallback(async () => {
    try {
      const status = await window.electronAPI.getDomainHealth();
      if (status?.success) setSnapshot(status);
    } catch { /* Health reporting must never interfere with navigation. */ }
  }, []);
  useEffect(() => {
    let active = true;
    const poll = async () => { if (active) await refresh(); };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);
  const domains = useMemo(() => snapshot.domains.filter(domain => domain.state !== 'healthy'), [snapshot.domains]);
  const commands = useMemo(() => snapshot.commands.filter(command => command.status === 'dead' || command.attempts > 0), [snapshot.commands]);
  if (!domains.length && !commands.length) return null;
  const hasFailure = domains.some(domain => domain.state === 'unavailable') || commands.some(command => command.status === 'dead');
  const componentNames = new Map(components.map(component => [component.id, component.name]));
  const domainLabel = (domain: DomainHealthSnapshot['domains'][number]) => {
    const componentId = domain.componentId || legacyComponentIdForDomain(domain.domainId);
    return domain.displayName || (componentId ? componentNames.get(componentId) : undefined) || DOMAIN_LABELS[domain.domainId] || domain.domainId;
  };
  const retryDead = async () => {
    const dead = commands.filter(command => command.status === 'dead');
    const results = await Promise.all(dead.map(command => window.electronAPI.retryDomainCommand(command.commandId)));
    const failed = results.filter(result => !result.success);
    onNotice(failed.length ? `${failed.length} 个跨域任务无法重试` : `已重新提交 ${dead.length} 个跨域任务`, 5000);
    await refresh();
  };
  return <div role="status" className={`relative z-40 flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs ${hasFailure ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
    <AlertTriangle size={15} className="shrink-0"/>
    <span className="min-w-0 flex-1 truncate"><strong>部分功能已隔离：</strong>{domains.map(domain => `${domainLabel(domain)}${domain.state === 'recovering' ? '正在恢复' : domain.state === 'degraded' ? '已降级' : '暂不可用'}`).join('、') || '跨域任务等待处理'}。其他功能仍可继续使用。</span>
    {commands.some(command => command.status === 'dead') && <button type="button" onClick={() => void retryDead()} className="shrink-0 rounded-md border border-current px-2.5 py-1 font-bold hover:bg-white/60">重试失败任务</button>}
  </div>;
};
