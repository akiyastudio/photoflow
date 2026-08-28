export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }
export type VersionedName = `${string}.v${number}`;
export type HostApiVersion = 7;
export type ComponentPermission = 'project.media.read' | 'project.input.read' | 'project.output.write' | 'project.version.create' | 'project.progress' | 'project.files.read' | 'project.versions.read' | 'project.media.ratings.read' | 'project.media.ratings.write' | 'project.version.write' | 'project.version.delete' | 'project.progress.manage' | 'project.import' | 'project.files.write' | 'project.media.process' | 'component.secrets' | 'network.fetch' | 'component.storage' | 'component.settings' | 'component.media' | 'tasks' | 'dialogs' | 'events' | 'component.lifecycle.read' | 'component.lifecycle.manage' | 'notifications';
export type ComponentHostErrorCode = 'COMPONENT_HOST_INVALID_REQUEST' | 'COMPONENT_HOST_PERMISSION_DENIED' | 'COMPONENT_HOST_NOT_FOUND' | 'COMPONENT_HOST_TOKEN_EXPIRED' | 'COMPONENT_HOST_TOKEN_SCOPE' | 'COMPONENT_HOST_LIMIT_EXCEEDED' | 'COMPONENT_HOST_VARIANT_UNAVAILABLE' | 'COMPONENT_HOST_CONFLICT' | 'COMPONENT_HOST_CANCELLED' | 'COMPONENT_HOST_TIMEOUT' | 'COMPONENT_HOST_SERVICE_EXITED' | 'COMPONENT_HOST_INTERNAL';
export interface ComponentHostError extends Error { code: ComponentHostErrorCode | `COMPONENT_SERVICE_${string}`; retryable: boolean; details?: JsonValue }
export interface ComponentContext { componentId: string; componentVersion: string; hostApiVersion: 7; surface: 'project' | 'application.settings' | 'component.sidePanel' | 'media.contextAction' | 'project.contextAction' | 'project.importProvider' | 'project.exportProvider' | 'application.command'; contributionId?: string; projectId: string; projectName: string; projectStatus: string; scopeRelativePath: string; selectedRelativePaths: string[]; permissions: ComponentPermission[]; events: VersionedName[]; resolvedTheme: 'light' | 'dark' }
export interface MediaPlaybackBackendV1Contribution { type: 'media.playbackBackend'; protocolVersion: 1; backendId: string; transport: 'native-process-v1'; priority: number; probe: { containers: string[]; codecs: { video: string[]; audio: string[] }; extensions: string[] }; features: { transforms: Array<'source' | 'contain' | 'cover' | '16:9' | '4:3' | '1:1' | 'rotate' | 'flip-horizontal' | 'flip-vertical'>; hdr: { modes: Array<'auto' | 'sdr' | 'hdr-passthrough' | 'tone-map'>; requiresHdrDisplay: boolean }; statistics: { levels: Array<'basic' | 'detailed'>; maxUpdateHz: number }; subtitles: { formats: Array<'vtt' | 'srt' | 'ass' | 'ssa'>; externalFiles: boolean }; hardwareDecoding: boolean; capture: { supported: boolean; appliesTransforms: boolean } } }
export interface MediaPlaybackBackendV1Envelope<TPayload extends object = Record<string, unknown>> { protocol: 'media-playback-backend-v1'; sessionId: string; sequence: number; timestamp: number; event: `command.${string}` | `event.${string}`; payload: TPayload }
export type MediaKind = 'image' | 'raw' | 'video';
export interface MediaPageRequest { pageSize?: number; cursor?: string | null; kinds?: MediaKind[] }
export interface MediaPageItem { mediaRef: { relativePath: string }; relativePath: string; name: string; kind: MediaKind; extension: string; size: number; updatedAt: number; viaExternalLink?: true }
export interface MediaPageResponse { apiVersion: 7; items: MediaPageItem[]; page: { hasMore: boolean; cursor: string | null; pageSize: number } }
export type MediaVariantName = 'thumbnail' | 'preview' | 'original';
export interface MediaVariantsRequest { photoId?: string; versionId?: string; relativePath?: string; variants?: MediaVariantName[] }
export interface DerivedMediaVariant { url: string; maxEdge: number; derived: true }
export interface OriginalMediaVariant { url: string; byteLength: number; derived: false }
export interface RestrictedInput { token: string; expiresAt: number }
export interface MediaVariantsResponse { apiVersion: 7; mediaRef: { photoId?: string; versionId?: string; relativePath?: string }; metadata: { photoId: string; versionId: string; currentVersionId: string; displayName: string; originalName: string; relativePath: string; isCurrent: boolean; fileMissing: boolean }; variants: { thumbnail?: DerivedMediaVariant; preview?: DerivedMediaVariant; original?: OriginalMediaVariant }; input?: RestrictedInput }
export interface InputMaterializeRequest { action: 'materialize'; token: string }
export interface InputMaterializeResponse { apiVersion: 7; inputId: string; privatePath: string; byteLength: number }
export type ComponentStorageRequest = Record<string, never>;
export interface ComponentStorageAdoptionPending {
  schemaVersion: 1; kind: 'component-storage-adoption'; state: 'pending'; componentId: string;
  fromHostApiVersion: 1; toHostApiVersion: 2; startedAt: number;
}
export interface ComponentStorageAdoptionCommitted {
  schemaVersion: 1; kind: 'component-storage-adoption'; state: 'committed'; componentId: string;
  fromHostApiVersion: 1; toHostApiVersion: 2; adoptedDataRoot: boolean; adoptedDatabase: boolean;
  legacyDataRoot: string; legacyDatabasePath: string; databaseSha256: string;
  copiedFileCount: number; copiedByteCount: number;
}
export type ComponentStorageResponse =
  | { apiVersion: 7; projectId: string; ownership: 'component-private'; adoption: ComponentStorageAdoptionPending }
  | { apiVersion: 7; dataPath: string; databasePath: string; projectId: string; ownership: 'component-private'; adoption?: ComponentStorageAdoptionCommitted };
export type ComponentSettingsRequest = { action: 'get' } | { action: 'replace' | 'merge'; settings: JsonObject };
export interface ComponentSettingsResponse { apiVersion: 7; revision: number; settings: JsonObject }
/** One-time adoption source allowed only with the versioned project.output.existing.v1 grant. */
export type ExistingOutputSource = ({ relativePath: string; sourcePath?: never } | { sourcePath: string; relativePath?: never }) & { artifactId?: string };
export type ProjectOutputRequest = { action: 'stage' } | { action: 'write'; stageId: string; name: string; outputRelativePath: string; sourceName?: string; inputToken?: string; base64?: string; replace?: boolean; previousCommitId?: string; previousArtifactId?: string; expectedDigest?: string } | { action: 'validate' | 'rollback'; stageId: string } | { action: 'commit'; stageId: string; idempotencyKey: string } | { action: 'adopt'; migrationId: string; outputs: ExistingOutputSource[] } | { action: 'delete'; previousCommitId: string; previousArtifactId: string; expectedDigest: string; idempotencyKey: string } | { action: 'materializeOwned'; commitId: string; artifactId: string };
export interface CommittedOutput { artifactId: string; relativePath: string; filePath?: string; byteLength: number; sha256: string }
export type ProjectOutputResponse = { apiVersion: 7; stageId: string; privatePath: string; expiresAt: number } | { apiVersion: 7; stageId: string; artifactId: string; byteLength: number } | { apiVersion: 7; stageId: string; valid: true; fileCount: number; totalBytes: number } | { apiVersion: 7; stageId: string; rolledBack: true } | { apiVersion: 7; commitId: string; idempotencyKey: string; outputs: CommittedOutput[] } | { apiVersion: 7; deletionId: string; deleted: true; relativePath: string } | { apiVersion: 7; importId: string; privatePath: string; byteLength: number; sha256: string; outputRef: { commitId: string; artifactId: string } };
export interface VersionCreateRequest { commitId: string; artifactId: string; photoId: string; parentVersionId: string; idempotencyKey: string; name?: string; type?: string; note?: string; isFinal?: boolean; status?: string }
export interface VersionCreateResponse { apiVersion: 7; versionId: string; result: JsonObject }
export type TaskAction = 'start' | 'report' | 'status' | 'cancel' | 'resume' | 'complete' | 'fail';
export interface TasksRequest { action: TaskAction; operationId: string; title?: string; message?: string; progress?: number; phase?: string; checkpoint?: JsonObject; error?: string }
export interface ComponentTaskSnapshot { id: string; state: string; checkpoint?: JsonObject; progress?: number; message?: string; error?: string }
export interface TasksResponse { apiVersion: 7; task: ComponentTaskSnapshot | null; cancelled: boolean; checkpoint?: JsonObject }
export type DialogsRequest = { kind: 'confirm'; title?: string; message?: string } | { kind: 'openFiles'; title?: string; extensions?: string[]; multiple?: boolean } | { kind: 'openOutput' | 'revealOutput'; commitId: string; artifactId: string };
export type DialogsResponse = { apiVersion: 7; confirmed: boolean } | { apiVersion: 7; cancelled: boolean; inputs: Array<{ name: string; token: string; expiresAt: number }> } | { apiVersion: 7; opened: true; outputRef: { commitId: string; artifactId: string } };
export interface ComponentEventRequest<T extends JsonObject = JsonObject> { topic: VersionedName; event: T }
export interface ComponentEventResponse { apiVersion: 7; emitted: true }
export type ComponentLifecycleRequest = { action: 'describe' } | { action: 'preflight' | 'install' | 'repair' | 'uninstall' };
export type ComponentLifecycleResponse = { apiVersion: 7; componentId: string; componentVersion: string; negotiatedHostApiVersion: HostApiVersion; permissions: ComponentPermission[]; events: VersionedName[]; lifecycleActions: string[]; state: 'active' } | { apiVersion: 7; success: true; action: 'preflight' | 'install' | 'repair' | 'uninstall'; taskId: string; message: string };
export type NotificationTone = 'info' | 'success' | 'warning' | 'error';
export interface NotificationRequest { tone: NotificationTone; message: string; dedupeKey?: string }
export type NotificationResult = { apiVersion: 7; accepted: true; id: string } | { apiVersion: 7; accepted: false; deduplicated: true; code: 'NOTIFICATION_DEDUPLICATED' } | { apiVersion: 7; accepted: false; error: { code: string; message: string; retryable: boolean } };
export interface ComponentMediaRequest { action: 'variants' | 'open' | 'reveal'; relativePath: string; variants?: MediaVariantName[] }
export type ComponentMediaResponse = { apiVersion: 7; opaqueRef: string; variants: MediaVariantsResponse['variants'] } | { apiVersion: 7; opaqueRef: string; action: 'open' | 'reveal'; opened: true };
export interface VersionSourceMetadata { category?: string; role?: string; displayName?: string; componentId?: string; parentCapability?: 'structural' | 'workflow-input' | 'none' }
export type ProjectProgressRequest = { action: 'list'; includeMissing?: boolean } | { action: 'create'; relativePath: string; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId: string; displayName?: string; trackingEnabled?: boolean; sourceMetadata?: VersionSourceMetadata; sourceProgressIds?: string[] } | { action: 'relate'; childProgressId: string; parentProgressId: string; expectedUpdatedAt?: number };
export type ProjectProgressResponse = { apiVersion: 7; progress: JsonObject[]; edges: JsonObject[] } | { apiVersion: 7; progress: JsonObject; edges: JsonObject[] } | { apiVersion: 7; result: JsonObject };
export interface BoundedPage { cursor: string | null; hasMore: boolean; pageSize: number; truncated: boolean }
export interface ProjectFileItem { relativePath: string; name: string; kind: 'directory' | 'file' | 'sidecar'; extension?: string; size?: number; updatedAt?: number }
export interface ProjectFilesPageRequest { pageSize?: number; cursor?: string | null }
export interface ProjectFilesSearchRequest extends ProjectFilesPageRequest { query: string }
export interface ProjectFilesPageResponse { apiVersion: 7; items: ProjectFileItem[]; page: BoundedPage }
export interface ProjectMediaMetadataRequest { relativePath: string }
export interface ProjectMediaMetadataResponse { apiVersion: 7; mediaRef: { relativePath: string }; kind: MediaKind; size: number; updatedAt: number; dimensions: { width: number | null; height: number | null }; colorSpace: JsonValue; camera: { make: JsonValue; model: JsonValue; lens: JsonValue }; capture: { aperture: number | null; exposureTime: JsonValue; iso: number | null; focalLength: number | null; takenAt: JsonValue }; video: { codec: JsonValue; audioCodec: JsonValue; durationSeconds: number | null; frameRate: number | null; rotation: number | null } | null }
export interface ProjectVersion { id: string; photoId: string; parentVersionId: string | null; versionNumber: number; name: string; type: string; status: string; note: string; isCurrent: boolean; isFinal: boolean; fileMissing: boolean; contentChanged: boolean; createdAt: number; updatedAt: number }
export interface ProjectVersionsPageResponse { apiVersion: 7; items: ProjectVersion[]; page: BoundedPage }
export interface ProjectVersionGraphResponse { apiVersion: 7; progress: JsonObject[]; versions: ProjectVersion[]; edges: Array<{ sourceId: string; targetId: string; kind: string }>; truncated: boolean }
export interface ProjectMediaRatingsRequest { mediaRefs: Array<{ relativePath: string }> }
export interface ProjectMediaRating { mediaRef: { relativePath: string }; revision: number; rating: number | null; labels: null; selectionState: null }
export interface ProjectMediaRatingsResponse { apiVersion: 7; supported: { rating: true; labels: false; selectionState: false }; items: ProjectMediaRating[] }
export interface ProjectMediaRatingWriteItem { relativePath: string; rating: 0 | 1 | 2 | 3 | 4 | 5; expectedRevision: number }
export interface ProjectMediaRatingsWriteRequest { items: ProjectMediaRatingWriteItem[]; idempotencyKey: string }
export interface ProjectMediaRatingsWriteResponse { apiVersion: 7; semantics: 'per-item'; succeeded: number; failed: number; items: Array<{ mediaRef: { relativePath: string }; ok: boolean; rating?: number; previousRevision?: number; revision?: number; error?: { code: ComponentHostErrorCode; message: string } }> }
export interface ProjectVersionUpdateRequest { versionId: string; expectedUpdatedAt: number; idempotencyKey: string; versionName?: string; note?: string; status?: string; isFinal?: boolean; makeCurrent?: true }
export interface ProjectVersionDeleteRequest { versionId: string; expectedUpdatedAt: number; idempotencyKey: string }
export type ProjectVersionMutationResponse = { apiVersion: 7; receiptId: string; version?: ProjectVersion; versionId?: string; deleted?: true };
export type ProjectProgressManageRequest = { action: 'update' | 'unregister' | 'edgeCreate' | 'edgeDelete' | 'edgeReplaceSource'; idempotencyKey: string; expectedUpdatedAt: number; progressId?: string; displayName?: string; trackingEnabled?: boolean; sourceProgressId?: string; targetProgressId?: string; newSourceProgressId?: string; edgeKind?: string };
export interface ProjectProgressManageResponse { apiVersion: 7; action: ProjectProgressManageRequest['action']; receiptId: string; progress?: JsonObject; edge?: JsonObject; progressId?: string }
export type ProjectImportRequest = { action: 'commit'; idempotencyKey: string; items: Array<{ inputToken: string; targetRelativePath: string }> } | { action: 'cancel'; idempotencyKey: string };
export interface ProjectImportResponse { apiVersion: 7; operationId: string; receiptId?: string; committed?: true; cancelled?: boolean; outputs?: Array<{ relativePath: string; size: number; sha256: string }> }
export type ProjectFilesMutateRequest = { phase: 'preflight'; action: 'rename' | 'move' | 'mkdir' | 'trash'; relativePaths?: string[]; targetRelativePath?: string; newName?: string } | { phase: 'commit'; planToken: string; idempotencyKey: string } | { phase: 'undo'; receiptId: string; idempotencyKey: string };
export type ProjectFilesMutateResponse = { apiVersion: 7; planToken: string; expiresAt: number; action: string; undoCapability: 'available' | 'requires-precise-recycle'; items: JsonObject[] } | { apiVersion: 7; receiptId: string; committed?: true; undone?: true; action?: string; undoAvailable?: boolean; undo?: JsonObject[] };
export type ProjectMediaProcessRequest = { action: 'video.timelineFrames'; relativePath: string; times: number[] } | { action: 'video.trim'; idempotencyKey: string; relativePath: string; start: number; end: number; outputRelativePath: string; mode: 'fast' | 'exact' } | { action: 'office.extractImages'; idempotencyKey: string; relativePath: string; outputDirectory: string } | { action: 'status' | 'cancel'; idempotencyKey: string; processAction: 'video.trim' | 'office.extractImages' };
export type ProjectMediaProcessResponse = { apiVersion: 7; action: ProjectMediaProcessRequest['action']; receiptId?: string; operationId?: string; frames?: string[]; output?: { relativePath: string; size: number; sha256: string }; outputs?: Array<{ relativePath: string; size: number; sha256: string }>; cancelled?: boolean; task?: { id: string; state: string; progress: number; message: string; checkpoint: JsonValue } | null };
export type ComponentSecretsRequest = { action: 'put'; name: string; value: string; metadata?: JsonObject; idempotencyKey: string } | { action: 'list' } | { action: 'delete'; secretRef: string; idempotencyKey: string };
export type ComponentSecretRecord = { secretRef: string; name: string; metadata: JsonObject; createdAt: number; updatedAt: number };
export type ComponentSecretsResponse = ({ apiVersion: 7 } & ComponentSecretRecord) | { apiVersion: 7; items: ComponentSecretRecord[] } | { apiVersion: 7; secretRef: string; deleted: true };
export type NetworkFetchRequest = { url: string; origin: `https://${string}`; method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string | JsonValue; bodyMode?: 'text' | 'json' | 'base64'; responseMode?: 'text' | 'json' | 'base64'; timeoutMs?: number; secrets?: Record<string, string> };
export type NetworkFetchResponse = { apiVersion: 7; status: number; headers: Record<string, string>; body: { text: string } | { json: JsonValue } | { base64: string }; truncated: false };
export interface HostCapabilityMap {
  'project.media.page.v7': { request: MediaPageRequest; response: MediaPageResponse };
  'project.media.variants.v7': { request: MediaVariantsRequest; response: MediaVariantsResponse };
  'project.input.tokens.v7': { request: InputMaterializeRequest; response: InputMaterializeResponse };
  'component.storage.v7': { request: ComponentStorageRequest; response: ComponentStorageResponse };
  'component.settings.v7': { request: ComponentSettingsRequest; response: ComponentSettingsResponse };
  'project.output.v7': { request: ProjectOutputRequest; response: ProjectOutputResponse };
  'version.create.v7': { request: VersionCreateRequest; response: VersionCreateResponse };
  'tasks.v7': { request: TasksRequest; response: TasksResponse };
  'dialogs.v7': { request: DialogsRequest; response: DialogsResponse };
  'component.events.v7': { request: ComponentEventRequest; response: ComponentEventResponse };
  'component.lifecycle.v7': { request: ComponentLifecycleRequest; response: ComponentLifecycleResponse };
  'component.media.v7': { request: ComponentMediaRequest; response: ComponentMediaResponse };
  'project.progress.v7': { request: ProjectProgressRequest; response: ProjectProgressResponse };
  'notifications.v7': { request: NotificationRequest; response: NotificationResult };
  'project.files.page.v7': { request: ProjectFilesPageRequest; response: ProjectFilesPageResponse };
  'project.files.search.v7': { request: ProjectFilesSearchRequest; response: ProjectFilesPageResponse };
  'project.media.metadata.v7': { request: ProjectMediaMetadataRequest; response: ProjectMediaMetadataResponse };
  'project.versions.page.v7': { request: ProjectFilesPageRequest; response: ProjectVersionsPageResponse };
  'project.version.graph.v7': { request: { includeMissing?: boolean }; response: ProjectVersionGraphResponse };
  'project.media.ratings.v7': { request: ProjectMediaRatingsRequest; response: ProjectMediaRatingsResponse };
  'project.media.ratings.write.v7': { request: ProjectMediaRatingsWriteRequest; response: ProjectMediaRatingsWriteResponse };
  'project.version.update.v7': { request: ProjectVersionUpdateRequest; response: ProjectVersionMutationResponse };
  'project.version.delete.v7': { request: ProjectVersionDeleteRequest; response: ProjectVersionMutationResponse };
  'project.progress.manage.v7': { request: ProjectProgressManageRequest; response: ProjectProgressManageResponse };
  'project.import.v7': { request: ProjectImportRequest; response: ProjectImportResponse };
  'project.files.mutate.v7': { request: ProjectFilesMutateRequest; response: ProjectFilesMutateResponse };
  'project.media.process.v7': { request: ProjectMediaProcessRequest; response: ProjectMediaProcessResponse };
  'component.secrets.v7': { request: ComponentSecretsRequest; response: ComponentSecretsResponse };
  'network.fetch.v7': { request: NetworkFetchRequest; response: NetworkFetchResponse };
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
export interface ComponentSdk { readonly contractVersion: 1; getContext(): Promise<ComponentContext>; readonly notify?: (payload: NotificationRequest) => Promise<NotificationResult>; rpc<T = unknown>(method: VersionedName, payload?: Record<string, unknown>): Promise<T>; onEvent<T = JsonObject>(topic: VersionedName, callback: (payload: T) => void): () => void; onActivate(callback: () => void): () => void; onDeactivate(callback: () => void): () => void; onThemeChange(callback: (value: { contractVersion: 1; resolvedTheme: 'light' | 'dark' }) => void): () => void; onContextChange(callback: (context: ComponentContext) => void): () => void }
declare global { interface Window { photoFlowComponent: ComponentSdk } }
export const host: ComponentSdk;
export function assertHostApiV7(context: ComponentContext): asserts context is ComponentContext & { hostApiVersion: 7 };
