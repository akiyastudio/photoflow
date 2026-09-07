export type ComponentContext = {
  componentId: string;
  componentVersion: string;
  surface: 'project' | 'application.settings';
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
  notify?: (payload: { tone: 'info' | 'success' | 'warning' | 'error'; message: string; dedupeKey?: string }) => Promise<{ accepted: boolean; deduplicated?: boolean; error?: { code: string; message: string; retryable: boolean } }>;
  dialog<T = unknown>(payload: { kind: string; [key: string]: unknown }): Promise<T>;
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>;
  onEvent(topic: string, callback: (value: unknown) => void): () => void;
  onActivate(callback: () => void): () => void;
  onDeactivate(callback: () => void): () => void;
  onThemeChange(callback: (value: { contractVersion: 1; resolvedTheme: 'light' | 'dark' }) => void): () => void;
  onContextChange(callback: (value: ComponentContext) => void): () => void;
};

declare global { interface Window { photoFlowComponent: ComponentSdk } }

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';
export type NoticeOptions = { dedupeKey?: string };
export const notify = (message: string, tone: NoticeTone, options: NoticeOptions = {}) => {
  const cleanMessage = String(message || '').trim().slice(0, 360);
  if (!cleanMessage) return;
  const api = window.photoFlowComponent?.notify;
  if (typeof api !== 'function') {
    (tone === 'error' ? console.error : console.warn)(`团片通知宿主不可用：${cleanMessage}`);
    return;
  }
  const dedupeKey = String(options.dedupeKey || '').trim().slice(0, 80) || undefined;
  void api({ tone, message: cleanMessage, dedupeKey }).then(result => {
    if (!result.accepted && !result.deduplicated) (tone === 'error' ? console.error : console.warn)(`团片通知未显示（${result.error?.code || 'UNKNOWN'}）：${cleanMessage}`);
  }).catch(error => (tone === 'error' ? console.error : console.warn)('团片通知调用失败', error));
};

const allowedMethods = new Set([
  'team.media.page.v1', 'team.progress.list.v1', 'team.progress.create.v1',
  'team.project.get.v1', 'team.project.register.v1', 'team.project.remove-photo.v1',
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
  'team.workflow.reconcile-drain.v1',
  'team.operation.run.v1', 'team.operation.get.v1', 'team.operation.cancel.v1',
  'team.settings.get.v1', 'team.settings.update.v1', 'team.advanced.status.v1', 'team.advanced.preflight.v1',
  'team.advanced.install.v1', 'team.advanced.uninstall.v1',
]);

export const readableComponentRpcError = (method: string, error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error || '');
  if (/ADVANCED_PACKAGE_MISSING/i.test(raw)) return '未找到高级环境包，请将独立环境 ZIP 放到设置页所示目录，保留原文件名后重试。';
  if (/NVIDIA GPU capability could not be verified|Failed to initialize NVML/i.test(raw)) return 'NVIDIA 驱动查询失败，请确认显卡驱动正常；若命令行查询正常，请更新团片插件后重试。';
  if (/CUDA-capable NVIDIA driver is required/i.test(raw)) return '未找到 NVIDIA 驱动查询工具，请先安装 NVIDIA 显卡驱动。';
  if (/Insufficient disk space/i.test(raw)) return '高级环境安装盘可用空间不足，请清理空间后重试。';
  if (/foreign or incomplete advanced ownership state exists/i.test(raw)) return '检测到已有或未完成安装的同名高级环境，不能直接覆盖。请先核对旧环境归属和安装状态。';
  if (/RPC method is not allowed on the application settings surface/i.test(raw)) return '团片插件的设置页面缺少操作权限声明，请安装修复后的插件；重启无法解决此问题。';
  if (/Advanced runtime package selection cancelled/i.test(raw)) return '已取消选择高级环境包。';
  if (/WSL 2 is not (installed|ready)/i.test(raw)) return 'WSL 2 尚未安装或未就绪，请先启用 WSL 2 后重试。';
  if (/does not match.*(SHA256|manifest)|package version does not match|runtime API version does not match/i.test(raw)) return '高级环境包校验不通过，请选择与当前插件匹配的独立高级环境 ZIP。';
  if (/timed out|timeout|COMPONENT_HOST_TIMEOUT/i.test(raw)) return method === 'team.project.get.v1'
    ? '团片历史读取超时，请重试；若持续发生，请重启应用后再打开项目。'
    : '团片服务响应超时，请稍后重试；当前操作会从上次安全进度继续。';
  if (/SQLITE_BUSY|database is locked|busy/i.test(raw)) return '团片数据正在整理，请稍后重试；已有进度不会丢失。';
  if (/service exited|restart|COMPONENT_HOST_SERVICE_EXITED/i.test(raw)) return '团片服务已重新启动，请重试当前操作。';
  const firstLine = raw.split(/\r?\n|\s+at\s+/)[0].replace(/^Error invoking remote method[^:]*:\s*/i, '').trim();
  return firstLine && /[\u3400-\u9fff]/.test(firstLine) && !/[A-Z]:\\|localhost|ipc/i.test(firstLine)
    ? firstLine.slice(0, 180) : '团片操作暂时失败，请重试；若持续发生，请重启应用。';
};
export type TeamMediaVariant = 'preview' | 'original';
export type TeamMediaAuthorizeRequest = { kind: 'original' | 'working' | 'returned' | 'review-return'; variant: TeamMediaVariant; photoId?: string; baseVersionId?: string; taskId?: string; personIndex?: number; reviewSessionId?: string; returnId?: string };

export const rpc = async <T = unknown>(method: string, payload?: unknown) => {
  if (!allowedMethods.has(method)) throw new Error(`组件未声明此能力：${method}`);
  try { return await window.photoFlowComponent.rpc<T>(method, payload); }
  catch (error) { throw new Error(readableComponentRpcError(method, error)); }
};

export const durableRpc = async <T = unknown>(method: string, payload: Record<string, unknown> = {}) => {
  const operationId = String(payload.operationId || crypto.randomUUID());
  const accepted = await rpc<Record<string, unknown>>(method, { ...payload, operationId, acceptOnly: true });
  if (accepted.success === false || accepted.accepted !== true) return accepted as T;
  return rpc<T>('team.operation.run.v1', { operationId: String(accepted.operationId || operationId) });
};
