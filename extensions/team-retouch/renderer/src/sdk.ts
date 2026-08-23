export type ComponentContext = {
  componentId: string;
  componentVersion: string;
  projectId: string;
  projectName: string;
  projectStatus: string;
};

export type ComponentSdk = {
  contractVersion: 1;
  getContext(): Promise<ComponentContext>;
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>;
  onEvent(topic: string, callback: (value: unknown) => void): () => void;
  onActivate(callback: () => void): () => void;
  onDeactivate(callback: () => void): () => void;
};

declare global { interface Window { photoFlowComponent: ComponentSdk } }

const allowedMethods = new Set([
  'project.files.list.v1', 'project.progress.list.v1', 'project.progress.create.v1',
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
  'component.settings.get.v1', 'component.settings.update.v1', 'component.advanced.preflight.v1',
  'component.advanced.install.v1', 'component.advanced.uninstall.v1',
]);

export const rpc = <T = unknown>(method: string, payload?: unknown) => {
  if (!allowedMethods.has(method)) throw new Error(`组件未声明此能力：${method}`);
  return window.photoFlowComponent.rpc<T>(method, payload);
};
