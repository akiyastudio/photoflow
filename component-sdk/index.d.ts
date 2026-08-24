export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }
export type VersionedName = `${string}.v${number}`;
export type HostApiVersion = 2;
export type ComponentPermission = 'project.media.read' | 'project.input.read' | 'project.output.write' | 'project.version.create' | 'project.progress' | 'component.storage' | 'component.settings' | 'component.media' | 'tasks' | 'dialogs' | 'events' | 'component.lifecycle.read' | 'component.lifecycle.manage';
export type ComponentHostErrorCode = 'COMPONENT_HOST_INVALID_REQUEST' | 'COMPONENT_HOST_PERMISSION_DENIED' | 'COMPONENT_HOST_NOT_FOUND' | 'COMPONENT_HOST_TOKEN_EXPIRED' | 'COMPONENT_HOST_TOKEN_SCOPE' | 'COMPONENT_HOST_LIMIT_EXCEEDED' | 'COMPONENT_HOST_VARIANT_UNAVAILABLE' | 'COMPONENT_HOST_CONFLICT' | 'COMPONENT_HOST_CANCELLED' | 'COMPONENT_HOST_TIMEOUT' | 'COMPONENT_HOST_SERVICE_EXITED' | 'COMPONENT_HOST_INTERNAL';
export interface ComponentHostError extends Error { code: ComponentHostErrorCode | `COMPONENT_SERVICE_${string}`; retryable: boolean; details?: JsonValue }
export interface ComponentContext { componentId: string; componentVersion: string; hostApiVersion: 1 | 2; projectId: string; projectName: string; projectStatus: string; scopeRelativePath: string; selectedRelativePaths: string[]; permissions: ComponentPermission[]; events: VersionedName[]; resolvedTheme: 'light' | 'dark' }
export type MediaKind = 'image' | 'raw' | 'video';
export interface MediaPageRequest { pageSize?: number; cursor?: string | null; kinds?: MediaKind[] }
export interface MediaPageItem { mediaRef: { relativePath: string }; relativePath: string; name: string; kind: MediaKind; extension: string; size: number; updatedAt: number; viaExternalLink?: true }
export interface MediaPageResponse { apiVersion: 2; items: MediaPageItem[]; page: { hasMore: boolean; cursor: string | null; pageSize: number } }
export type MediaVariantName = 'thumbnail' | 'preview' | 'original';
export interface MediaVariantsRequest { photoId?: string; versionId?: string; relativePath?: string; variants?: MediaVariantName[] }
export interface DerivedMediaVariant { url: string; maxEdge: number; derived: true }
export interface OriginalMediaVariant { url: string; byteLength: number; derived: false }
export interface RestrictedInput { token: string; expiresAt: number }
export interface MediaVariantsResponse { apiVersion: 2; mediaRef: { photoId?: string; versionId?: string; relativePath?: string }; metadata: { photoId: string; versionId: string; currentVersionId: string; displayName: string; originalName: string; relativePath: string; isCurrent: boolean; fileMissing: boolean }; variants: { thumbnail?: DerivedMediaVariant; preview?: DerivedMediaVariant; original?: OriginalMediaVariant }; input?: RestrictedInput }
export interface InputMaterializeRequest { action: 'materialize'; token: string }
export interface InputMaterializeResponse { apiVersion: 2; inputId: string; privatePath: string; byteLength: number }
export type ComponentStorageRequest = Record<string, never>;
export interface ComponentStorageResponse { apiVersion: 2; dataPath: string; databasePath: string; projectId: string; ownership: 'component-private'; adoption?: { kind: 'component-storage-adoption'; fromHostApiVersion: 1; state: 'committed'; legacyDataRoot: string; legacyDatabasePath: string; databaseSha256: string } }
export type ComponentSettingsRequest = { action: 'get' } | { action: 'replace' | 'merge'; settings: JsonObject };
export interface ComponentSettingsResponse { apiVersion: 2; revision: number; settings: JsonObject }
export type ProjectOutputRequest = { action: 'stage' } | { action: 'write'; stageId: string; name: string; outputRelativePath: string; sourceName?: string; inputToken?: string; base64?: string; replace?: boolean; previousCommitId?: string; previousArtifactId?: string; expectedDigest?: string } | { action: 'validate' | 'rollback'; stageId: string } | { action: 'commit'; stageId: string; idempotencyKey: string } | { action: 'adoptLegacyV1'; migrationId: string; outputs: Array<{ relativePath: string; artifactId?: string }> } | { action: 'delete'; previousCommitId: string; previousArtifactId: string; expectedDigest: string; idempotencyKey: string } | { action: 'materializeOwned'; commitId: string; artifactId: string };
export interface CommittedOutput { artifactId: string; relativePath: string; filePath: string; byteLength: number; sha256: string }
export type ProjectOutputResponse = { apiVersion: 2; stageId: string; privatePath: string; expiresAt: number } | { apiVersion: 2; stageId: string; artifactId: string; byteLength: number } | { apiVersion: 2; stageId: string; valid: true; fileCount: number; totalBytes: number } | { apiVersion: 2; stageId: string; rolledBack: true } | { apiVersion: 2; commitId: string; idempotencyKey: string; outputs: CommittedOutput[] } | { apiVersion: 2; deletionId: string; deleted: true; relativePath: string } | { apiVersion: 2; importId: string; privatePath: string; byteLength: number; sha256: string; outputRef: { commitId: string; artifactId: string } };
export interface VersionCreateRequest { commitId: string; artifactId: string; photoId: string; parentVersionId: string; idempotencyKey: string; name?: string; type?: string; note?: string; isFinal?: boolean; status?: string }
export interface VersionCreateResponse { apiVersion: 2; versionId: string; result: JsonObject }
export type TaskAction = 'start' | 'report' | 'status' | 'cancel' | 'resume' | 'complete' | 'fail';
export interface TasksRequest { action: TaskAction; operationId: string; title?: string; message?: string; progress?: number; phase?: string; checkpoint?: JsonObject; error?: string }
export interface ComponentTaskSnapshot { id: string; state: string; checkpoint?: JsonObject; progress?: number; message?: string; error?: string }
export interface TasksResponse { apiVersion: 2; task: ComponentTaskSnapshot | null; cancelled: boolean; checkpoint?: JsonObject }
export type DialogsRequest = { kind: 'confirm'; title?: string; message?: string } | { kind: 'openFiles'; title?: string; extensions?: string[]; multiple?: boolean } | { kind: 'openOutput' | 'revealOutput'; commitId: string; artifactId: string };
export type DialogsResponse = { apiVersion: 2; confirmed: boolean } | { apiVersion: 2; cancelled: boolean; inputs: Array<{ name: string; token: string; expiresAt: number }> } | { apiVersion: 2; opened: true; outputRef: { commitId: string; artifactId: string } };
export interface ComponentEventRequest<T extends JsonObject = JsonObject> { topic: VersionedName; event: T }
export interface ComponentEventResponse { apiVersion: 2; emitted: true }
export type ComponentLifecycleRequest = { action: 'describe' } | { action: 'preflight' | 'install' | 'repair' | 'uninstall' };
export type ComponentLifecycleResponse = { apiVersion: 2; componentId: string; componentVersion: string; negotiatedHostApiVersion: 2; permissions: ComponentPermission[]; events: VersionedName[]; lifecycleActions: string[]; state: 'active' } | { apiVersion: 2; success: true; action: 'preflight' | 'install' | 'repair' | 'uninstall'; taskId: string; message: string };
export interface ComponentMediaRequest { action: 'variants' | 'open' | 'reveal'; relativePath: string; variants?: MediaVariantName[] }
export type ComponentMediaResponse = { apiVersion: 2; opaqueRef: string; variants: MediaVariantsResponse['variants'] } | { apiVersion: 2; opaqueRef: string; action: 'open' | 'reveal'; opened: true };
export type ProjectProgressRequest = { action: 'list'; includeMissing?: boolean } | { action: 'create'; relativePath: string; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId: string; displayName?: string; trackingEnabled?: boolean; sourceProgressIds?: string[] } | { action: 'relate'; childProgressId: string; parentProgressId: string; expectedUpdatedAt?: number };
export type ProjectProgressResponse = { apiVersion: 2; progress: JsonObject[]; edges: JsonObject[] } | { apiVersion: 2; progress: JsonObject; edges: JsonObject[] } | { apiVersion: 2; result: JsonObject };
export interface HostCapabilityMap {
  'project.media.page.v2': { request: MediaPageRequest; response: MediaPageResponse };
  'project.media.variants.v2': { request: MediaVariantsRequest; response: MediaVariantsResponse };
  'project.input.tokens.v2': { request: InputMaterializeRequest; response: InputMaterializeResponse };
  'component.storage.v2': { request: ComponentStorageRequest; response: ComponentStorageResponse };
  'component.settings.v2': { request: ComponentSettingsRequest; response: ComponentSettingsResponse };
  'project.output.v2': { request: ProjectOutputRequest; response: ProjectOutputResponse };
  'version.create.v2': { request: VersionCreateRequest; response: VersionCreateResponse };
  'tasks.v2': { request: TasksRequest; response: TasksResponse };
  'dialogs.v2': { request: DialogsRequest; response: DialogsResponse };
  'component.events.v2': { request: ComponentEventRequest; response: ComponentEventResponse };
  'component.lifecycle.v2': { request: ComponentLifecycleRequest; response: ComponentLifecycleResponse };
  'component.media.v2': { request: ComponentMediaRequest; response: ComponentMediaResponse };
  'project.progress.v2': { request: ProjectProgressRequest; response: ProjectProgressResponse };
}
export type HostCapability = keyof HostCapabilityMap;
export type HostCapabilityRequest<K extends HostCapability> = HostCapabilityMap[K]['request'];
export type HostCapabilityResponse<K extends HostCapability> = HostCapabilityMap[K]['response'];
export interface ServiceHostCaller { callHost<K extends HostCapability>(parentId: string, method: K, payload: HostCapabilityRequest<K>): Promise<HostCapabilityResponse<K>> }
export interface ReadyFrame { type: 'ready'; protocolVersion: 1 }
export interface ServiceRequestFrame<M extends VersionedName = VersionedName, P extends JsonObject = JsonObject> { type: 'request'; id: string; method: M; payload: P; context: Omit<ComponentContext, 'scopeRelativePath' | 'selectedRelativePaths' | 'events' | 'resolvedTheme'> }
export interface ServiceSuccessFrame<R extends JsonValue = JsonValue> { type: 'response'; id: string; ok: true; result: R }
export interface ServiceFailureFrame { type: 'response'; id: string; ok: false; error: string; errorCode: ComponentHostErrorCode | `COMPONENT_SERVICE_${string}`; retryable?: boolean }
export type CapabilityRequestFrame<K extends HostCapability = HostCapability> = K extends HostCapability ? { type: 'capability'; id: string; parentId: string; method: K; payload: HostCapabilityRequest<K> } : never;
export type CapabilityResponseFrame<K extends HostCapability = HostCapability> = { type: 'capability-response'; id: string; ok: true; result: HostCapabilityResponse<K> } | { type: 'capability-response'; id: string; ok: false; error: string; errorCode: ComponentHostErrorCode; retryable?: boolean };
export type ComponentServiceInboundFrame = ServiceRequestFrame | CapabilityResponseFrame;
export type ComponentServiceOutboundFrame = ReadyFrame | ServiceSuccessFrame | ServiceFailureFrame | CapabilityRequestFrame;
export interface ComponentSdk { readonly contractVersion: 1; getContext(): Promise<ComponentContext>; rpc<T = unknown>(method: VersionedName, payload?: Record<string, unknown>): Promise<T>; onEvent<T = JsonObject>(topic: VersionedName, callback: (payload: T) => void): () => void; onActivate(callback: () => void): () => void; onDeactivate(callback: () => void): () => void; onThemeChange(callback: (value: { contractVersion: 1; resolvedTheme: 'light' | 'dark' }) => void): () => void; onContextChange(callback: (context: ComponentContext) => void): () => void }
declare global { interface Window { photoFlowComponent: ComponentSdk } }
export const host: ComponentSdk;
export function assertHostApiV2(context: ComponentContext): asserts context is ComponentContext & { hostApiVersion: 2 };
