import { useEffect, useRef, useState } from 'react';
import type { ComponentSettingsPageContribution } from '../../types';

export const ComponentSettingsPageSurface = ({ page, onError }: { page: ComponentSettingsPageContribution; onError: (message: string) => void }) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [instanceId, setInstanceId] = useState('');

  useEffect(() => {
    let disposed = false;
    const leaseId = `settings-${globalThis.crypto.randomUUID()}`;
    void window.electronAPI.openComponentSettingsPage({ componentId: page.componentId, pageId: page.pageId, leaseId }).then(result => {
      if (!result.success || !result.page) throw new Error(result.error || '打开组件设置页失败');
      if (result.page.leaseId !== leaseId) throw new Error('组件设置页 lease 不匹配');
      if (!disposed) setInstanceId(result.page.instanceId);
    }).catch(error => { if (!disposed) onError(error instanceof Error ? error.message : String(error)); });
    return () => {
      disposed = true;
      void window.electronAPI.releaseComponentSettingsPage({ componentId: page.componentId, pageId: page.pageId, leaseId }).catch(() => undefined);
    };
  }, [onError, page.componentId, page.componentVersion, page.pageId]);

  useEffect(() => {
    if (!instanceId) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = surface.getBoundingClientRect();
      void window.electronAPI.setComponentPageBounds(instanceId, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    window.addEventListener('resize', schedule);
    void window.electronAPI.activateComponentPage(instanceId);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [instanceId]);

  return <div ref={surfaceRef} aria-label={`${page.pageTitle} 组件设置页`} className="h-full w-full bg-white"/>;
};

