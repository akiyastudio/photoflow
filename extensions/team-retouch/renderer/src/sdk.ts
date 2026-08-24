export type ComponentContext = {
  componentId: string;
  componentVersion: string;
  projectId: string;
  projectName: string;
  projectStatus: string;
  scopeRelativePath: string;
  selectedRelativePaths: string[];
  sourcePageId: string;
  themeContractVersion: 1;
  resolvedTheme: 'light' | 'dark';
};

export type ComponentSdk = {
  contractVersion: 1;
  getContext(): Promise<ComponentContext>;
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>;
  onEvent(topic: string, callback: (value: unknown) => void): () => void;
  onActivate(callback: () => void): () => void;
  onDeactivate(callback: () => void): () => void;
  onThemeChange(callback: (value: { contractVersion: 1; resolvedTheme: 'light' | 'dark' }) => void): () => void;
  onContextChange(callback: (value: ComponentContext) => void): () => void;
};

declare global { interface Window { photoFlowComponent: ComponentSdk } }

const allowedMethods = new Set([
  'team.media.page.v1', 'team.progress.list.v1', 'team.progress.create.v1',
  'team.project.get.v1', 'team.project.register.v1', 'team.project.remove-photo.v1',
  'team.project.migrate-step.v1',
  'team.media.authorize.v1', 'team.patch.open.v1',
  'team.identity.similarities.v1', 'team.identity.suggest.v1', 'team.identity.save.v1',
  'team.identity.assign.v1', 'team.identity.confirm-group.v1', 'team.identity.complete.v1', 'team.identity.delete.v1',
  'team.person.exclude.v1', 'team.patch.get.v1', 'team.patch.detect.v1', 'team.patch.detect-batch.v1',
  'team.patch.update.v1', 'team.patch.delete.v1', 'team.patch.cleanup.v1', 'team.patch.upload.v1',
  'team.patch.remove-upload.v1', 'team.patch.select-returns.v1', 'team.patch.return-batch.v1',
  'team.patch.merge.v1',
  'team.workflow.settings.save.v1', 'team.workflow.generate.v1', 'team.workflow.status.v1',
  'team.workflow.cancel.v1', 'team.workflow.export.v1', 'team.workflow.open-export.v1', 'team.workflow.return-batch.v1',
  'team.workflow.return-review.get.v1', 'team.workflow.return-review.discard.v1',
  'team.workflow.return-review.ignore.v1', 'team.workflow.return-confirm.v1',
  'team.settings.get.v1', 'team.settings.update.v1', 'team.advanced.preflight.v1',
  'team.advanced.install.v1', 'team.advanced.uninstall.v1',
]);

export const readableComponentRpcError = (method: string, error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error || '');
  if (/timed out|timeout|COMPONENT_HOST_TIMEOUT/i.test(raw)) return method === 'team.project.get.v1'
    ? '团片历史读取超时，请重试；若持续发生，请重启应用后再打开项目。'
    : '团片服务响应超时，请稍后重试；当前操作会从上次安全进度继续。';
  if (/SQLITE_BUSY|database is locked|busy/i.test(raw)) return '团片数据正在整理，请稍后重试；已有进度不会丢失。';
  if (/service exited|restart|COMPONENT_HOST_SERVICE_EXITED/i.test(raw)) return '团片服务已重新启动，请重试当前操作。';
  if (/Host 存储迁移凭据|storage adoption/i.test(raw)) return '团片历史存储校验未通过，请重启应用后重试；若仍失败，请保留原数据并联系支持。';
  const firstLine = raw.split(/\r?\n|\s+at\s+/)[0].replace(/^Error invoking remote method[^:]*:\s*/i, '').trim();
  return firstLine && /[\u3400-\u9fff]/.test(firstLine) && !/[A-Z]:\\|localhost|ipc/i.test(firstLine)
    ? firstLine.slice(0, 180) : '团片操作暂时失败，请重试；若持续发生，请重启应用。';
};

export const rpc = async <T = unknown>(method: string, payload?: unknown) => {
  if (!allowedMethods.has(method)) throw new Error(`组件未声明此能力：${method}`);
  try { return await window.photoFlowComponent.rpc<T>(method, payload); }
  catch (error) { throw new Error(readableComponentRpcError(method, error)); }
};
