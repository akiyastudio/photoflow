export type HostApiVersion = 2;
export type ComponentPermission = 'project.media.read' | 'project.input.read' | 'project.output.write' | 'project.version.create' | 'component.storage' | 'component.settings' | 'tasks' | 'dialogs' | 'events' | 'component.lifecycle.read';

export interface ComponentContext {
  componentId: string;
  componentVersion: string;
  hostApiVersion: 1 | 2;
  projectId: string;
  projectName: string;
  projectStatus: string;
  scopeRelativePath: string;
  selectedRelativePaths: string[];
  permissions: ComponentPermission[];
  events: string[];
  resolvedTheme: 'light' | 'dark';
}

export interface ComponentSdk {
  readonly contractVersion: 1;
  getContext(): Promise<ComponentContext>;
  rpc<T = unknown>(method: `${string}.v${number}`, payload?: Record<string, unknown>): Promise<T>;
  onEvent<T = unknown>(topic: `${string}.v${number}`, callback: (payload: T) => void): () => void;
  onActivate(callback: () => void): () => void;
  onDeactivate(callback: () => void): () => void;
  onThemeChange(callback: (value: { contractVersion: 1; resolvedTheme: 'light' | 'dark' }) => void): () => void;
  onContextChange(callback: (context: ComponentContext) => void): () => void;
}

declare global { interface Window { photoFlowComponent: ComponentSdk } }

export const host: ComponentSdk;
export function assertHostApiV2(context: ComponentContext): asserts context is ComponentContext & { hostApiVersion: 2 };
