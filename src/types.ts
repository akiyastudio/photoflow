export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export type ToolType = 'home' | 'inspiration' | 'project' | 'project-version' | 'project-team' | 'settings' | 'dashboard' | 'match' | 'video_split';

export type Theme = 'light' | 'dark' | 'system';
export type HomeCardId = 'birthday' | 'import' | 'inspiration';
export const PROJECT_TOOLBAR_ACTION_IDS = [
  'sd-import', 'negative-import', 'progress-import', 'broll-import', 'file-import',
  'filename-selection', 'storyboard', 'video-transcode', 'video-split',
  'png-converter', 'screenshot-main-image', 'office-extract', 'project-trash',
  'select-media', 'photoshop', 'version-management', 'team-retouch', 'final-versions',
] as const;
export type ProjectToolbarActionId = typeof PROJECT_TOOLBAR_ACTION_IDS[number];
export interface ProjectToolbarSettings {
  order: ProjectToolbarActionId[];
  hidden: ProjectToolbarActionId[];
  onlyShowAvailable: boolean;
}
export type ProjectFileSortField = 'name' | 'date' | 'size';
export const BUILT_IN_PROJECT_STATUSES = ['策划中', '待拍摄', '后期中', '已归档'] as const;
export type BuiltInProjectStatus = typeof BUILT_IN_PROJECT_STATUSES[number];
/** Project status names are persisted values; built-ins are reserved and users may add more. */
export type ProjectStatus = '未分类' | BuiltInProjectStatus | (string & {});
export interface TeamRetouchComponentSettings {
  useGpu: boolean;
  oversizeCropMode: 'face-centered' | 'expand';
}
export interface AdvancedVideoComponentSettings {
  arrowKeyAction: 'seek' | 'navigate';
}
export interface ResearchSettings {
  sensitivity: 'low' | 'standard' | 'high';
  minDuration: number;
  /** legacy config field */
  ssimThreshold?: number;
}
export interface InspirationLibrarySettings {
  rootPath: string;
}
export interface ComponentSettingsMap {
  'team-retouch'?: TeamRetouchComponentSettings;
  'video-playback-mpv'?: AdvancedVideoComponentSettings;
  [componentId: string]: unknown;
}
export const PROJECT_STATUS_LABELS: Record<string, string> = {
  未分类: '未分类',
  策划中: '策划中',
  待拍摄: '待拍摄',
  后期中: '后期中',
  已归档: '已归档'
};
export const projectStatusLabel = (status: ProjectStatus) => PROJECT_STATUS_LABELS[status] || status;
export const normalizeProjectCategoryOrder = (value: unknown, customCategories: readonly string[] = []) => {
  const available = [...BUILT_IN_PROJECT_STATUSES, ...customCategories];
  const byKey = new Map(available.map(name => [name.toLocaleLowerCase(), name]));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const key = String(item || '').trim().toLocaleLowerCase();
    const name = byKey.get(key);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  for (const name of available) {
    const key = name.toLocaleLowerCase();
    if (!seen.has(key)) result.push(name);
  }
  return result;
};
export const normalizeWorkspacePaths = (primary: unknown, paths: unknown) => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of [primary, ...(Array.isArray(paths) ? paths : [])]) {
    const workspacePath = String(value || '').trim();
    const key = workspacePath.toLocaleLowerCase();
    if (!workspacePath || seen.has(key)) continue;
    seen.add(key);
    result.push(workspacePath);
  }
  return result;
};
export interface ProjectDate {
  year: number;
  month: number;
  day?: number;
  precision: 'month' | 'day';
}
export interface WorkspaceProject {
  name: string;
  path: string;
  /** Workspace root that owns this project when multiple roots are configured. */
  workspacePath?: string;
  status: ProjectStatus;
  updatedAt: number;
  projectDate?: ProjectDate;
  availability?: 'available' | 'missing';
  missingSince?: number;
  missingChecks?: number;
  archived?: boolean;
  archivePath?: string;
  archiveVerifiedAt?: number;
  archiveBytes?: number;
}
export interface WorkspaceStatusGroup { status: ProjectStatus; projects: WorkspaceProject[]; }

export interface BackupSnapshotSummary {
  id: string;
  createdAt: number;
  files: number;
  bytes: number;
  projects: number;
  projectItems?: Array<{ id: string; name: string; status: ProjectStatus; relativePath: string }>;
  reason: string;
  mode: 'history' | 'latest';
}

export interface BackupStatus {
  success: boolean;
  enabled: boolean;
  state: 'unconfigured' | 'offline' | 'never-backed-up' | 'running' | 'protected' | 'error';
  targetPath?: string;
  isNas?: boolean;
  connection?: BackupConnectionStatus;
  mode?: 'history' | 'latest';
  latestAt?: number;
  latestSnapshotId?: string;
  snapshotCount?: number;
  task?: BackgroundTask;
  snapshots: BackupSnapshotSummary[];
  error?: string;
}

export interface BackupConnectionStatus {
  connected: boolean;
  isNas: boolean;
  checkedAt?: number;
  latencyMs?: number;
  speedMBps?: number;
  totalBytes?: number;
  freeBytes?: number;
  error?: string;
}

export interface BackupSpaceStatus {
  success: boolean;
  targetPath?: string;
  snapshotCount?: number;
  workspaceSnapshotCount?: number;
  objectCount?: number;
  logicalBytes?: number;
  actualBytes?: number;
  referencedBytes?: number;
  deduplicatedBytes?: number;
  currentBytes?: number;
  historyBytes?: number;
  internalBytes?: number;
  reclaimableBytes?: number;
  expiredSnapshotCount?: number;
  estimatedReclaimableBytes?: number;
  totalBytes?: number;
  freeBytes?: number;
  error?: string;
}

export interface StorageUsageItem {
  kind: 'workspace' | 'inspiration' | 'archive' | 'backup' | 'cache' | 'internal';
  label: string;
  path: string;
  bytes: number;
  measured: boolean;
}

export interface StorageVolumeUsage {
  id: string;
  label: string;
  root: string;
  online: boolean;
  totalBytes?: number;
  freeBytes?: number;
  photoflowBytes: number;
  otherBytes: number;
  items: StorageUsageItem[];
}

export interface StorageUsageOverview {
  success: boolean;
  updatedAt: number;
  scanning: boolean;
  stale: boolean;
  volumes: StorageVolumeUsage[];
  error?: string;
}

export interface AppConfig {
  theme: Theme;
  telemetry: {
    enabled: boolean;
    crashReports: boolean;
  };
  workspacePath: string;
  /** All project roots; workspacePath is the default write destination. */
  workspacePaths: string[];
  autoCleanupDeletedProjectData: boolean;
  createPlanningFolder: boolean;
  customProjectCategories: string[];
  projectCategoryOrder: string[];
  defaultFolderSort: ProjectFileSortField;
  itemOpenMode: 'single' | 'double';
  favoriteDisplayMode: 'stars' | 'binary';
  usagePreferencesVersion: number;
  projectToolbar: ProjectToolbarSettings;
  homeOrder: HomeCardId[];
  birthdayEnabled: boolean;
  pinInspirationLibrary: boolean;
  componentSettings: ComponentSettingsMap;
  mediaCache: {
    maxSizeGB: number;
    directory: string;
    autoCleanup30Days: boolean;
  };
  backup: {
    enabled: boolean;
    targetType: 'local' | 'nas';
    targetPath: string;
    mode: 'history' | 'latest';
    automaticDaily: boolean;
    afterImport: boolean;
    retention: {
      daily: number;
      weekly: number;
      monthly: number;
    };
    nas: {
      credentialRef: string;
      limitEnabled: boolean;
      bandwidthLimitMBps: number;
      limitStart: string;
      limitEnd: string;
    };
  };
  archive: {
    enabled: boolean;
    targetPath: string;
  };
  importDefaults: {
    deleteSourceAfterImport: boolean;
    generateJpgFromRaw: boolean;
  };
  smartImport: {
    autoStart: boolean;
    sdPath: string;
    sdPaths: string[];
    sdDriveTypes: Record<string, 'work' | 'broll'>;
    destPath: string;
    backupEnabled: boolean;
    backupPath: string;
    generateVideoPreview: boolean;
    videoPreviewQuality: 'medium' | 'high';
    splitLargeFiles: boolean;
    dateFilter: 'all' | 'today' | 'today_yesterday';
  };
  brollImport: {
    splitLargeFiles: boolean;
  };
  inspirationLibrary: InspirationLibrarySettings;
  /** Compatibility mirror for versions before componentSettings. */
  personDetection: TeamRetouchComponentSettings;
  smartMatch: {
    imageDestFolderName: string;
    videoDestFolderName: string;
    imageSourceFolderName?: string;
    videoSourceFolderName?: string;
    /** legacy config field */
    destFolderName?: string;
  };
  /** Built-in storyboard analysis settings. */
  research: ResearchSettings;
}

export interface PrivacyConsentState {
  privacyNoticeVersion: string;
  privacyNoticeAcceptedAt: string;
  termsVersion: string;
  termsAcceptedAt: string;
  faceRulesVersion: string;
  faceRecognitionGrantedAt: string;
  faceRecognitionGranted: boolean;
  currentPrivacyNoticeVersion: string;
  currentTermsVersion: string;
  currentFaceRulesVersion: string;
}

export type LegalDocumentId = 'privacy' | 'terms' | 'face' | 'information-list' | 'third-parties' | 'permissions' | 'children' | 'customer-data' | 'open-source';

export interface ProjectFileEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: 'folder' | 'image' | 'video' | 'raw' | 'shortcut' | 'file';
  extension: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  previewUrl?: string;
  /** Rating stored in the media file's XMP metadata. */
  rating?: number;
  /** Entry discovered by following a folder shortcut in recursive mode. */
  viaShortcut?: boolean;
}

export interface ShellNewFileType {
  id: string;
  extension: string;
  label: string;
  method: 'null' | 'data' | 'template';
  iconDataUrl?: string;
}

export type ThumbnailState = 'NOT_READY' | 'QUEUED' | 'GENERATING' | 'READY' | 'STALE' | 'FAILED' | 'MISSING';

export interface MediaMetadataField {
  group: string;
  name: string;
  value: string;
}

export interface TrackedPhoto {
  id: string;
  projectId: string;
  mediaType: 'image' | 'video';
  originalName: string;
  displayName: string;
  currentVersionId: string;
  originalFilePath: string;
  captureTime?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MediaVersion {
  id: string;
  photoId: string;
  parentVersionId?: string;
  versionNumber: number;
  displayVersionKey?: string;
  versionName: string;
  versionType: 'original' | 'first' | 'second' | 'third' | 'primary' | 'secondary' | 'custom' | string;
  filePath: string;
  fileSize: number;
  fileModifiedAt?: number;
  thumbnailPath?: string;
  author?: string;
  note: string;
  status: string;
  isCurrent: boolean;
  isFinal: boolean;
  fileMissing: boolean;
  contentChanged: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MediaVersionBundle {
  success: boolean;
  photo?: TrackedPhoto;
  versions: MediaVersion[];
  nextVersionNumber?: number;
  cancelled?: boolean;
  warning?: string;
  error?: string;
}

export interface VersionBatch {
  id: string;
  projectId: string;
  sequence: number;
  displayName: string;
  sourceFolderPath: string;
  parentBatchId?: string;
  parentSequence?: number;
  status: 'importing' | 'applying' | 'ready' | 'needs_repair' | 'failed' | string;
  itemCount: number;
  matchedCount: number;
  newCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProgressFolder {
  id: string;
  projectId: string;
  mediaKind: 'image' | 'video';
  versionKey: string;
  parentProgressId?: string;
  parentVersionKey?: string;
  displayName: string;
  folderPath: string;
  folderMissing: boolean;
  missingSince?: number;
  trackingEnabled: boolean;
  trackingState: 'disabled' | 'pending_compare' | 'pending_confirm' | 'committing' | 'ready' | 'needs_repair';
  repairBatchId?: string;
  pendingOperationCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface VersionBatchFileOperation {
  id: string;
  batchId: string;
  operationType: 'rename' | 'copy';
  sourcePath: string;
  targetPath: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  attemptCount: number;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamPatchTask {
  id: string;
  photoId: string;
  baseVersionId: string;
  personIndex: number;
  personName: string;
  assignee: string;
  detector: string;
  bbox: { x: number; y: number; width: number; height: number };
  members?: Array<{
    personIndex: number;
    confidence?: number;
    bbox: { x: number; y: number; width: number; height: number };
    faceBox?: { x: number; y: number; width: number; height: number } | null;
  }>;
  crop: { x: number; y: number; width: number; height: number };
  patchPath: string;
  patchMissing?: boolean;
  maskPath?: string;
  mask?: { width?: number; height?: number; scale?: number };
  needsReview?: boolean;
  reviewReason?: string;
  editedPatchPath?: string;
  status: 'exported' | 'uploaded' | 'merged' | string;
  mergeMetrics?: Record<string, number>;
  mergedVersionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamPatchBundle extends MediaVersionBundle {
  tasks: TeamPatchTask[];
  excludedPersonCount?: number;
  excludedPersonCounts?: Record<string, number>;
  detection?: { detector: string; backend?: 'gpu' | 'cpu' | string; provider?: string; requestedMode?: 'auto' | 'basic' | 'advanced'; advancedBackend?: boolean; width: number; height: number; personCount?: number; workTileEdge?: number; needsReviewCount?: number; fallbackReason?: string };
  merge?: { outputPath: string; outputProgressId?: string; versionId?: string; mergedCount: number; conflictPixels: number; seamScore: number; needsReview?: boolean };
}

export interface TeamIdentity {
  id: string;
  name: string;
  color: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamPersonAssignment {
  photoId: string;
  baseVersionId: string;
  personIndex: number;
  identityId?: string;
  confidence: number;
  source: 'manual' | 'suggested' | string;
  completed: boolean;
  completionKind?: '' | 'returned' | 'no-retouch' | 'skip-requested' | string;
  editedPatchPath?: string;
  returnMissing?: boolean;
  returnMissingSince?: number;
  completedAt?: number;
  updatedAt: number;
}

export interface TeamProjectPhoto {
  photoId: string;
  baseVersionId: string;
  name: string;
  relativePath: string;
  sourcePath: string;
  tasks: TeamPatchTask[];
  excludedPersonCount?: number;
}

export interface TeamIdentityWorkspace {
  success: boolean;
  photos: TeamProjectPhoto[];
  identities: TeamIdentity[];
  assignments: TeamPersonAssignment[];
  missingReturnCount?: number;
  workflowGenerated?: boolean;
  workflowNeedsRegeneration?: boolean;
  workflowAvailableKeys?: string[];
  workflowSettings?: {
    preferredIdentityOrder?: string[];
    preferredIdentityId?: string;
    sameWeekIdentityIds?: string[];
  };
  similarities?: Array<{
    leftKey: string;
    rightKey: string;
    score: number;
    faceScore?: number;
    bodyScore: number;
    evidence: 'face+body' | 'body-only' | string;
  }>;
  error?: string;
}

export interface TeamPatchReturnMatch {
  returnId: string;
  sourceName: string;
  path: string;
  mediaPath?: string;
  matched: boolean;
  accepted: boolean;
  confidence: 'high' | 'medium' | 'low' | 'unmatched' | string;
  score: number;
  margin: number;
  taskId?: string;
  photoId?: string;
  baseVersionId?: string;
  personIndex?: number;
  photoName?: string;
  personName?: string;
  patchPath?: string;
  alternatives?: Array<{
    taskId?: string;
    photoId?: string;
    baseVersionId?: string;
    personIndex?: number;
    identityId?: string;
    photoName?: string;
    personName?: string;
    patchPath?: string;
    score: number;
  }>;
}

export interface TeamPatchReturnBatchResult {
  success: boolean;
  cancelled?: boolean;
  returnedCount?: number;
  candidateCount?: number;
  acceptedCount?: number;
  reviewCount?: number;
  missingTaskCount?: number;
  mergedCount?: number;
  matches: TeamPatchReturnMatch[];
  merges: Array<{ photoId: string; photoName: string; relativePath?: string; success: boolean; skipped?: boolean; outputPath?: string; versionId?: string; baseVersionId?: string; needsReview?: boolean; error?: string }>;
  error?: string;
  warning?: string;
  reviewSessionId?: string;
}

export interface ComponentStatus {
  id: string;
  name: string;
  description: string;
  capability: string;
  installed: boolean;
  compatible: boolean;
  version: string;
  path: string;
  source: 'user' | 'development' | 'missing' | string;
  sizeBytes: number;
  error?: string;
  runtimeAvailable?: boolean;
  gpuAvailable?: boolean;
  advancedAvailable?: boolean;
  mergeAvailable?: boolean;
  identityAvailable?: boolean;
  faceBackend?: string;
  bodyBackend?: string;
  identityError?: string;
  provider?: string;
  advancedProvider?: string;
  providers?: string[];
  runtimeError?: string;
  gpuError?: string;
  advancedError?: string;
  packagePath?: string;
  advancedSizeBytes?: number;
  advancedFreeBytes?: number;
  advancedState?: 'ready' | 'not-installed' | 'repair-needed';
}

export interface AdvancedVideoState {
  sessionId: string;
  type: 'ready' | 'loading' | 'file-loaded' | 'state' | 'ended' | 'navigate' | 'context-menu' | 'pointer-activity' | 'escape' | 'error' | 'fatal';
  time?: number;
  duration?: number;
  paused?: boolean;
  buffering?: boolean;
  muted?: boolean;
  volume?: number;
  speed?: number;
  width?: number;
  height?: number;
  direction?: -1 | 1;
  x?: number;
  y?: number;
  error?: string;
}

export interface ProjectFileOperationProgress {
  operationId: string;
  projectName?: string;
  operation: 'paste' | 'import' | 'import-project' | 'trash' | 'import-broll' | 'import-files' | 'import-progress' | 'import-sd' | 'import-negative';
  phase: 'scanning' | 'moving' | 'copying' | 'splitting' | 'finishing' | 'trashing' | 'complete' | 'cancelled' | 'failed';
  progress: number;
  currentName?: string;
  bytesCopied?: number;
  totalBytes?: number;
  filesCopied?: number;
  totalFiles?: number;
  processedCount?: number;
  totalCount?: number;
  count?: number;
  error?: string;
}

export interface TeamWorkflowGenerationProgress {
  operationId: string;
  projectName: string;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  phase: 'preparing' | 'copying' | 'resuming' | 'finalizing' | 'cancelling' | 'complete' | 'cancelled' | 'failed' | string;
  progress: number;
  completedFiles: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
  currentName: string;
  message: string;
  error?: string;
}

export interface BackgroundTask {
  id: string;
  type: string;
  title: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  cancellable: boolean;
  retryable: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  finishedAt: number;
  error?: string;
}

export interface IElectronAPI {
  readonly apiContractVersion: number;
  onPythonEvent: any;
  runScript: (scriptName: string, args?: string[], requestId?: string) => void;
  cancelPythonTask: (requestId: string) => Promise<{ success: boolean; error?: string }>;
  getBirthdays: () => Promise<Record<string, string>>;
  saveBirthdays: (data: Record<string, string>) => Promise<{success: boolean, error?: string}>;
  loadConfig: () => Promise<AppConfig | null>;
  saveConfig: (config: AppConfig) => Promise<{success: boolean, error?: string}>;
  getPrivacyConsentState: () => Promise<PrivacyConsentState>;
  savePrivacyConsent: (request: { acceptCore?: boolean; revokeCore?: boolean; faceRecognitionGranted?: boolean }) => Promise<{ success: boolean; state?: PrivacyConsentState; error?: string }>;
  openLegalDocument: (documentId: LegalDocumentId) => Promise<{ success: boolean; path?: string; error?: string }>;
  clearTelemetryLocalData: () => Promise<{ success: boolean; error?: string }>;
  getUserPath: () => Promise<string>;
  onUpdateAvailable: (callback: (info: { version: string; url: string; notes: string }) => void) => () => void;
  openExternal: (url: string) => void;
  checkForUpdates: () => Promise<{ success: boolean; updateAvailable?: boolean; currentVersion?: string; latestVersion?: string; url?: string; notes?: string; sha256?: string; error?: string }>;
  submitFeedback: (message: string) => Promise<{ success: boolean; error?: string }>;
  getComponents: () => Promise<{ success: boolean; components: ComponentStatus[]; installPath: string; error?: string }>;
  onComponentsStatusChanged: (callback: (result: { success: boolean; components: ComponentStatus[]; installPath: string; error?: string }) => void) => () => void;
  openComponentsFolder: (componentId?: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  openLogsFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
  clearLogs: () => Promise<{ success: boolean; deletedCount?: number; error?: string }>;
  clearInterfaceCache: () => Promise<{ success: boolean; clearedBytes?: number; error?: string }>;
  getCursorScreenPoint: () => Promise<{ x: number; y: number }>;
  installComponent: (componentId: string) => Promise<{ success: boolean; cancelled?: boolean; packageSizeBytes?: number; error?: string }>;
  deleteComponentPackage: (kind: 'component' | 'advanced', componentId?: string) => Promise<{ success: boolean; deletedBytes?: number; error?: string }>;
  uninstallComponent: (componentId: string) => Promise<{ success: boolean; error?: string }>;
  checkTeamRetouchAdvancedRequirements: () => Promise<{ success: boolean; message?: string; error?: string }>;
  installTeamRetouchAdvanced: (options?: { repair?: boolean }) => Promise<{ success: boolean; cancelled?: boolean; restartRequired?: boolean; packageSizeBytes?: number; error?: string }>;
  uninstallTeamRetouchAdvanced: () => Promise<{ success: boolean; error?: string }>;
  onTeamRetouchAdvancedProgress: (callback: (value: { phase: string; progress?: number; message: string }) => void) => () => void;
  getDrives: () => Promise<string[]>;
  setTheme: (theme: Theme) => Promise<void>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
  isWindowMaximized: () => Promise<boolean>;
  setWindowFullscreen: (enabled: boolean) => Promise<boolean>;
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  getWorkspaceProjects: (workspacePath: string) => Promise<{ success: boolean; root?: string; statuses: WorkspaceStatusGroup[]; error?: string }> ;
  onWorkspaceFilesChanged: (callback: (change: { root: string; fileName: string; eventType?: 'rename' | 'change'; reconciled?: boolean; watcherFailed?: boolean }) => void) => () => void;
  onWorkspaceProjectsChanged: (callback: (change: { root: string }) => void) => () => void;
  createWorkspaceProject: (workspacePath: string, date: ProjectDate | null, name: string, options?: { createPlanningFolder?: boolean }) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  chooseExistingProject: () => Promise<{ success: boolean; cancelled?: boolean; sourcePath?: string; name?: string; fileCount?: number; folderCount?: number; totalBytes?: number; truncated?: boolean; candidates?: Array<{ relativePath: string; name: string; imageCount: number; rawCount: number; videoCount: number; fileCount: number; mediaKind: 'image' | 'video'; suggestedRole: 'baseline' | 'progress' }>; error?: string }>;
  importExistingProject: (workspacePath: string, sourcePath: string, options: { name: string; mode: 'copy' | 'move' }) => Promise<{ success: boolean; cancelled?: boolean; operationId?: string; project?: WorkspaceProject; sourceRetained?: boolean; candidates?: Array<{ relativePath: string; name: string; imageCount: number; rawCount: number; videoCount: number; fileCount: number; mediaKind: 'image' | 'video'; suggestedRole: 'baseline' | 'progress' }>; error?: string }>;
  renameWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, date: ProjectDate | null, nextName: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  renameProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, nextName: string) => Promise<{ success: boolean; folder?: { name: string; path: string; updatedAt: number }; error?: string }> ;
  createProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, relativePath?: string, makeUnique?: boolean) => Promise<{ success: boolean; folder?: { name: string; path: string; relativePath?: string; updatedAt: number }; error?: string }> ;
  getShellNewFileTypes: (refresh?: boolean) => Promise<{ success: boolean; types: ShellNewFileType[]; error?: string }>;
  createProjectShellNewFile: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, typeId: string) => Promise<{ success: boolean; file?: { name: string; path: string; relativePath: string; extension: string; updatedAt: number }; error?: string }>;
  undoLastRename: (workspacePath?: string, options?: { restoreConflictPolicy?: 'rename' | 'overwrite' }) => Promise<{ success: boolean; message?: string; project?: WorkspaceProject; requiresDecision?: { kind: 'restore-conflict'; names: string[]; conflictCount: number; message: string; detail: string }; error?: string }> ;
  moveWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, nextStatus: ProjectStatus) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  archiveImportedProjects: (workspacePath: string, projectNames?: string[]) => Promise<{ success: boolean; projects: WorkspaceProject[]; error?: string }>;
  trashWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; operationId?: string; permanent?: boolean; error?: string; errorCode?: string }>;
  cleanupDeletedWorkspaceProjects: (workspacePath: string) => Promise<{ success: boolean; checkedCount: number; cleanedCount: number; outcomes: Array<{ projectId: string; name: string; cleaned: boolean; status: 'in_recycle_bin' | 'missing' | 'restored' | 'unknown'; removedArtifactCount?: number }>; error?: string }>;

  getProjectContents: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; folders: Array<{ name: string; path: string; updatedAt: number }>;error?: string }> ;
  watchFileRoot: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; root?: string; error?: string }>;
  unwatchFileRoot: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; error?: string }>;
  browseProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, relativePath?: string, cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; path?: string; entries: ProjectFileEntry[]; missingDirectory?: boolean; error?: string }>;
  inspectProjectToolSources: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[], collectVideos?: boolean, collectDirectPng?: boolean) => Promise<{ success: boolean; indexed: boolean; hasVideo: boolean; hasPng: boolean; videoPaths: string[]; pngPaths: string[]; folderPaths: string[]; error?: string }>;
  resolveProjectShortcut: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; target?: string; targetKind?: 'folder' | 'file'; error?: string }>;
  searchProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, scopeRelativePath: string, query: string) => Promise<{ success: boolean; scope?: string; entries: ProjectFileEntry[]; error?: string }>;
  listRecentProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, scopeRelativePath: string, limit?: number, cursor?: string) => Promise<{ success: boolean; scope?: string; entries: ProjectFileEntry[]; cursor?: string; hasMore?: boolean; truncated?: boolean; scannedDirectories?: number; error?: string; errorCode?: 'RECENT_FILES_SESSION_EXPIRED' }>;
  listWorkspaceFolders: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; folders: Array<{ name: string; relativePath: string; parentRelativePath: string; depth: number }>; truncated?: boolean; error?: string }>;
  addInspirationToProject: (inspirationRoot: string, targetWorkspacePath: string, targetStatus: ProjectStatus, targetProjectName: string, relativePaths: string[]) => Promise<{ success: boolean; count?: number; fileCount?: number; shortcutCount?: number; planningFolder?: string; error?: string }>;
  extractOfficeImages: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; documentCount?: number; successfulCount?: number; failedCount?: number; imageCount?: number; results: Array<{ document: string; documentName: string; success: boolean; count: number; totalBytes?: number; outputFolder?: string; files?: string[]; message?: string; error?: string }>; error?: string }>;
  extractScreenshotMainImages: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[], options?: { requestId?: string; analyzeOnly?: boolean; crops?: Array<{ x: number; y: number; width: number; height: number }>; outputSuffix?: '主图' | '裁剪' }) => Promise<{
    success: boolean;
    inputCount?: number;
    croppedCount?: number;
    skippedCount?: number;
    failedCount?: number;
    reviewCount?: number;
    results: Array<{
      input: string;
      inputName: string;
      success: boolean;
      cropped: boolean;
      skipped?: boolean;
      analyzed?: boolean;
      detected?: boolean;
      needsReview?: boolean;
      output?: string;
      outputName?: string;
      confidence?: number;
      crop?: { x: number; y: number; width: number; height: number };
      snapGuides?: { x: number[]; y: number[] };
      originalSize?: { width: number; height: number };
      outputSize?: { width: number; height: number };
      reason?: string;
      error?: string;
    }>;
    error?: string;
  }>;
  trimProjectVideo: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, request: { start: number; end: number; saveMode: 'new' | 'replace' }) => Promise<{ success: boolean; outputPath?: string; relativePath?: string; duration?: number; replaced?: boolean; error?: string }>;
  onScreenshotMainImageProgress: (callback: (progress: { requestId: string; phase: 'extracting' | 'complete' | 'failed' | string; progress: number; processedCount?: number; totalCount?: number; currentName?: string; message: string }) => void) => () => void;
  getProjectFileDetails: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; details: Array<{ relativePath: string; size: number; createdAt: number; updatedAt: number }>; error?: string }>;
  getProjectEntryDetails: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; details?: { size: number; createdAt: number; updatedAt: number; fileCount: number; folderCount: number }; error?: string }>;
  getMediaVersions: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<MediaVersionBundle>;
  updateMediaVersion: (workspacePath: string, request: { versionId: string; versionName?: string; note?: string; isFinal?: boolean; makeCurrent?: boolean }) => Promise<MediaVersionBundle>;
  relocateMediaVersion: (workspacePath: string, status: ProjectStatus, name: string, request: { photoId: string; versionId: string; filePath?: string; force?: boolean }) => Promise<MediaVersionBundle & { requiresDecision?: { kind: 'version-fingerprint-mismatch'; filePath: string; message: string; detail: string } }>;
  deleteMediaVersion: (workspacePath: string, request: { photoId: string; versionId: string; trashFile?: boolean }) => Promise<MediaVersionBundle>;
  getMediaVersionDeleteScope: (workspacePath: string, versionId: string) => Promise<{ success: boolean; versionNumber: number; versionCount: number; missingCount: number; allMissing: boolean; childCount: number; selectedChildCount: number; error?: string }>;
  deleteProjectMissingMediaVersion: (workspacePath: string, versionId: string) => Promise<{ success: boolean; deletedCount: number; versionNumber?: number; reparentedCount?: number; removedArtifactCount?: number; error?: string }>;
  recordMediaVersionCompare: (workspacePath: string, request: { photoId: string; leftVersionId: string; rightVersionId: string; compareMode: string }) => Promise<{ success: boolean; error?: string }>;
  openMediaVersion: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  getProgressFolders: (workspacePath: string, projectName: string) => Promise<{ success: boolean; progressFolders: ProgressFolder[]; error?: string }>;
  ensureSelectionBaseline: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; registered: boolean; count: number; imageCount?: number; videoCount?: number; progressFolder?: ProgressFolder; batch?: VersionBatch; baselines?: Array<{ mediaKind: 'image' | 'video'; count: number; progressFolder?: ProgressFolder; batch?: VersionBatch }>; error?: string }>;
  getFinalVersionSummary: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; count: number; availableCount: number; missingCount: number; error?: string }>;
  browseFinalVersions: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; count: number; availableCount: number; missingCount: number; entries: ProjectFileEntry[]; error?: string }>;
  exportFinalVersions: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; count: number; displayName?: string; versionKey?: string; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  getMediaRating: (filePath: string) => Promise<{ success: boolean; rating: number; error?: string }>;
  setMediaRating: (workspacePath: string, filePath: string, rating: number) => Promise<{ success: boolean; rating: number; error?: string }>;
  createProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; displayName: string }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  registerProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { relativePath: string; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; displayName: string; trackingEnabled: boolean; trackingState?: ProgressFolder['trackingState']; progressId?: string }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; error?: string }>;
  updateProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { progressId: string; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; displayName: string; trackingEnabled: boolean; trackingState?: ProgressFolder['trackingState']; preserveFolderPath?: boolean }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; progressFolders?: ProgressFolder[]; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  deleteMissingProgressFolder: (workspacePath: string, projectName: string, progressId: string) => Promise<{ success: boolean; progressId?: string; versionKey?: string; deletedVersionCount?: number; deletedBatchCount?: number; reparentedProgressCount?: number; removedArtifactCount?: number; error?: string }>;
  registerVersionBaseline: (workspacePath: string, status: ProjectStatus, projectName: string, relativePath: string) => Promise<{ success: boolean; batch?: VersionBatch; error?: string }>;
  compareVersionFolders: (workspacePath: string, status: ProjectStatus, projectName: string, referenceRelativePath: string, sourceRelativePath: string, sourceNames?: string[]) => Promise<{ success: boolean; matches: Array<{ source: string; reference: string; target: string; confidence: string; distance: number }>; suggestions: Array<{ source: string; reference: string; target: string; confidence: string; distance: number }>; unmatched: string[]; unmatchedReference: string[]; error?: string }>;
  commitVersionBatch: (workspacePath: string, status: ProjectStatus, projectName: string, request: { folderA: string; folderB: string; importKey: string; displayName?: string; renameSources?: boolean; copyMissingReferences?: string[]; reconcileExisting?: boolean; incrementalSources?: string[]; matches: Array<{ reference: string; source: string; target?: string; distance: number; confidence: string }> }) => Promise<{ success: boolean; alreadyCommitted?: boolean; reconciled?: boolean; repairRequired?: boolean; operationCount?: number; referenceBatch?: VersionBatch; batch?: VersionBatch; renamedCount?: number; renameErrors?: Array<{ operationId?: string; source: string; target: string; error: string }>; copiedMissingCount?: number; copyMissingErrors?: Array<{ name: string; error: string }>; error?: string }>;
  getVersionBatchOperations: (workspacePath: string, batchId: string) => Promise<{ success: boolean; batch?: VersionBatch; operations: VersionBatchFileOperation[]; error?: string }>;
  retryVersionBatchOperations: (workspacePath: string, batchId: string) => Promise<{ success: boolean; repairRequired?: boolean; batch?: VersionBatch; renamedCount?: number; renameErrors?: Array<{ operationId?: string; source: string; target: string; error: string }>; error?: string }>;
  getTeamPatches: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<TeamPatchBundle>;
  getTeamProjectWorkspace: (workspacePath: string, name: string, status?: ProjectStatus) => Promise<TeamIdentityWorkspace>;
  getTeamIdentitySimilarities: (workspacePath: string, name: string) => Promise<{ success: boolean; similarities: NonNullable<TeamIdentityWorkspace['similarities']>; error?: string }>;
  registerTeamProjectPhotos: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<TeamIdentityWorkspace>;
  suggestTeamIdentities: (workspacePath: string, name: string) => Promise<TeamIdentityWorkspace & { suggestedCount?: number; candidateGroupCount?: number; unmatchedCount?: number; method?: string; faceBackend?: string; bodyBackend?: string; provider?: string }>;
  saveTeamIdentity: (workspacePath: string, request: { projectName: string; identityId?: string; name: string; assignments?: Array<{ photoId: string; baseVersionId: string; personIndex: number; confidence?: number; source?: string; completed?: boolean }> }) => Promise<{ success: boolean; identityId?: string; error?: string }>;
  assignTeamIdentity: (workspacePath: string, request: { projectName: string; photoId: string; baseVersionId: string; personIndex: number; identityId?: string; confidence?: number; source?: string; completed?: boolean }) => Promise<{ success: boolean; error?: string }>;
  confirmTeamIdentityGroup: (workspacePath: string, request: { projectName: string; anchorSubjectKey: string; identityId?: string; name?: string; assignments: Array<{ photoId: string; baseVersionId: string; personIndex: number; confidence?: number }> }) => Promise<TeamIdentityWorkspace & { identityId?: string; updatedCount?: number; autoReleasedCount?: number; duplicateSkippedCount?: number }>;
  completeTeamIdentity: (workspacePath: string, request: { photoId: string; baseVersionId: string; personIndex: number; completed: boolean; completionKind?: 'no-retouch' | ''; taskId?: string; taskOrder?: number[]; projectName?: string; status?: ProjectStatus }) => Promise<{ success: boolean; deferred?: boolean; warning?: string; error?: string }>;
  deleteTeamIdentity: (workspacePath: string, request: { projectName: string; identityId: string }) => Promise<{ success: boolean; error?: string }>;
  saveTeamWorkflowSettings: (workspacePath: string, request: { projectName: string; preferredIdentityOrder?: string[]; preferredIdentityId?: string; sameWeekIdentityIds?: string[] }) => Promise<{ success: boolean; workflowSettings?: { preferredIdentityOrder?: string[]; preferredIdentityId?: string; sameWeekIdentityIds?: string[] }; error?: string }>;
  excludeTeamPerson: (workspacePath: string, status: ProjectStatus, projectName: string, request: { photoId: string; baseVersionId: string; personIndex: number }) => Promise<TeamIdentityWorkspace & TeamPatchBundle & { removedPersonCount?: number; workflowRefreshCount?: number; warning?: string; error?: string }>;
  removeProjectTeamPhoto: (workspacePath: string, request: { photoId: string; baseVersionId: string }) => Promise<{ success: boolean; removedArtifactCount?: number; error?: string }>;
  generateTeamWorkflow: (workspacePath: string, status: ProjectStatus, name: string, request: { operationId?: string; replace?: boolean; preferredIdentityOrder?: string[]; preferredIdentityId?: string; sameWeekIdentityIds?: string[]; groups: Array<{ week: number; identityId: string; identityName: string; items: Array<{ photoId: string; baseVersionId: string; personIndex: number; taskId: string; photoName: string }> }> }) => Promise<{ success: boolean; requiresConfirmation?: boolean; alreadyRunning?: boolean; cancelled?: boolean; resumable?: boolean; operationId?: string; count?: number; groupCount?: number; path?: string; error?: string }>;
  getTeamWorkflowGenerationStatus: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; job: TeamWorkflowGenerationProgress | null; error?: string }>;
  cancelTeamWorkflowGeneration: (operationId: string) => Promise<{ success: boolean; cancelled: boolean; error?: string }>;
  onTeamWorkflowGenerationProgress: (callback: (value: TeamWorkflowGenerationProgress) => void) => () => void;
  exportTeamIdentityTasks: (workspacePath: string, status: ProjectStatus, name: string, request: { week: number; identityId: string }) => Promise<{ success: boolean; count?: number; path?: string; error?: string }>;
  returnTeamWorkflowBatch: (workspacePath: string, name: string, request: { status: ProjectStatus; returnedFiles: string[]; items: Array<{ photoId: string; baseVersionId: string; personIndex: number; taskId: string; taskOrder: number[] }> }) => Promise<TeamPatchReturnBatchResult>;
  getTeamWorkflowReturnReview: (workspacePath: string, name: string, status: ProjectStatus) => Promise<{ success: boolean; review: TeamPatchReturnBatchResult | null; error?: string }>;
  discardTeamWorkflowReturnReview: (workspacePath: string, name: string, reviewSessionId: string) => Promise<{ success: boolean; discarded: boolean; error?: string }>;
  ignoreTeamWorkflowReturnReview: (workspacePath: string, name: string, reviewSessionId: string, returnId: string) => Promise<{ success: boolean; reviewSessionCompleted: boolean; error?: string }>;
  confirmTeamWorkflowReturn: (workspacePath: string, name: string, request: { status: ProjectStatus; returnedPath: string; reviewSessionId?: string; returnId?: string; photoId: string; baseVersionId: string; personIndex: number; taskId: string; taskOrder: number[] }) => Promise<{ success: boolean; taskId?: string; editedPatchPath?: string; reviewSessionCompleted?: boolean; warning?: string; error?: string }>;
  detectTeamPatchPeople: (workspacePath: string, status: ProjectStatus, name: string, request: { photoId: string; baseVersionId: string; restoreExcluded?: boolean }) => Promise<TeamPatchBundle>;
  onTeamPatchDetectionProgress: (callback: (value: { photoId: string; baseVersionId: string; progress: number; message: string }) => void) => () => void;
  detectTeamPatchBatch: (workspacePath: string, status: ProjectStatus, name: string, request: { relativePaths: string[] }) => Promise<{ success: boolean; persistentBackend?: boolean; requestedMode?: string; advancedUsedCount?: number; fallbackCount?: number; results: Array<{ relativePath: string; name: string; success: boolean; photoId?: string; baseVersionId?: string; personCount?: number; workTileCount?: number; deliveryDirectory?: string; detector?: string; fallbackReason?: string; error?: string }>; error?: string }>;
  onTeamPatchBatchProgress: (callback: (value: { itemIndex: number; itemCount: number; relativePath: string; itemName: string; progress: number; message: string }) => void) => () => void;
  updateTeamPatch: (workspacePath: string, request: { photoId?: string; taskId: string; status?: ProjectStatus; projectName?: string; personName?: string; assignee?: string; crop?: { x: number; y: number; width: number; height: number }; needsReview?: boolean; reviewReason?: string }) => Promise<{ success: boolean; tasks: TeamPatchTask[]; workflowRefreshCount?: number; warning?: string; error?: string }>;
  deleteTeamPatch: (workspacePath: string, request: { photoId: string; taskId: string }) => Promise<{ success: boolean; tasks: TeamPatchTask[]; removedArtifactCount?: number; error?: string }>;
  cleanupTeamPatches: (workspacePath: string, request: { photoId: string; baseVersionId: string }) => Promise<TeamPatchBundle & { removedArtifactCount?: number }>;
  uploadTeamPatch: (workspacePath: string, request: { photoId: string; taskId: string; personIndex: number; projectName?: string; status?: ProjectStatus }) => Promise<{ success: boolean; cancelled?: boolean; tasks: TeamPatchTask[]; warning?: string; error?: string }>;
  removeTeamPatchUpload: (workspacePath: string, request: { photoId: string; taskId: string; personIndex: number; projectName?: string; status?: ProjectStatus }) => Promise<{ success: boolean; tasks: TeamPatchTask[]; removedArtifactCount?: number; warning?: string; error?: string }>;
  selectTeamPatchReturns: (projectName: string) => Promise<{ success: boolean; cancelled?: boolean; files?: string[]; error?: string }>;
  returnTeamPatchBatch: (workspacePath: string, status: ProjectStatus, name: string, request: { relativePaths: string[]; returnedFiles?: string[]; outputProgressId?: string }) => Promise<TeamPatchReturnBatchResult>;
  onTeamPatchReturnBatchProgress: (callback: (value: { phase: 'matching' | 'importing' | 'merging' | 'complete' | string; progress: number; message: string }) => void) => () => void;
  openTeamPatch: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  openTeamPatchFolder: (filePath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  mergeTeamPatches: (workspacePath: string, status: ProjectStatus, name: string, request: { photoId: string; baseVersionId: string; outputProgressId: string; versionName?: string }) => Promise<TeamPatchBundle>;
  getMediaThumbnail: (filePath: string, kind: 'image' | 'raw' | 'video', cacheConfig?: AppConfig['mediaCache'], requestedSize?: number, priority?: 0 | 1 | 2 | 3, queueOrder?: number) => Promise<{ success: boolean; taskId?: string; state?: ThumbnailState; previewUrl?: string; mediaUrl?: string; usingImportedPreview?: boolean; importedVideoWithoutPreview?: boolean; cacheLayer?: 'memory' | 'disk' | 'source'; error?: string }>;
  cancelMediaThumbnail: (filePath: string, requestedSize?: number) => Promise<{ success: boolean; cancelled: boolean; error?: string }>;
  onThumbnailStateChanged: (callback: (update: { filePath: string; state: ThumbnailState; previewUrls?: Partial<Record<'small' | 'medium' | 'large', string>>; sourceMtimeMs?: number; sourceSize?: number; error?: string }) => void) => () => void;
  startAdvancedVideo: (filePath: string, arrowKeyAction?: AdvancedVideoComponentSettings['arrowKeyAction']) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
  setAdvancedVideoBounds: (sessionId: string, bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
    overlayHole?: { x: number; y: number; width: number; height: number };
    cornerOverlayHole?: { x: number; y: number; width: number; height: number };
  }) => void;
  controlAdvancedVideo: (sessionId: string, request: { action: 'play' | 'pause' | 'seek' | 'volume' | 'mute' | 'speed' | 'stop'; value?: number | boolean }) => void;
  captureAdvancedVideoFrame: (sessionId: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  stopAdvancedVideo: (sessionId: string) => Promise<{ success: boolean }>;
  onAdvancedVideoState: (callback: (state: AdvancedVideoState) => void) => () => void;
  getMediaOriginal: (filePath: string, kind: 'image' | 'raw', cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; mediaUrl?: string; original?: boolean; orientation?: { matrix: number[]; swapsAxes: boolean; rawOrientation: number; embeddedOrientation: number }; error?: string }>;
  getMediaMetadata: (filePath: string) => Promise<{ success: boolean; fields: MediaMetadataField[]; error?: string }>;
  reportRendererError: (message: string, details?: string) => void;
  trackTelemetry: (eventName: string, properties?: Record<string, string | number | boolean>) => void;
  onAppError: (callback: (message: string) => void) => () => void;
  getRawPreview: (filePath: string, cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; previewUrl?: string; error?: string }>;
  projectFileOperation: (workspacePath: string, status: ProjectStatus, projectName: string, operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename' | 'select' | 'move' | 'import', paths: string[], targetRelativePath?: string, nextName?: string, options?: { imageDestFolderName?: string; videoDestFolderName?: string; renameNames?: string[]; pasteConflictPolicy?: 'replace' | 'keep-both' }) => Promise<{ success: boolean; cancelled?: boolean; count?: number; permanentCount?: number; imageCount?: number; videoCount?: number; operationId?: string; moves?: Array<{ sourceRelativePath: string; destinationRelativePath: string }>; createdItems?: Array<{ name: string; relativePath: string; isDirectory: boolean }>; replacedCount?: number; replacedNames?: string[]; replacedPermanentCount?: number; replacedRetainedCount?: number; requiresDecision?: { kind: 'paste-conflict'; names: string[]; fileCount: number; folderCount: number; message: string; detail: string }; error?: string; errorCode?: string }>;
  getProjectFileClipboardStatus: () => Promise<{ success: boolean; hasFiles: boolean; error?: string }>;
  cancelProjectFileCut: (workspacePath: string, status: ProjectStatus, projectName: string, paths: string[]) => Promise<{ success: boolean; cleared: boolean; hasFiles: boolean; error?: string }>;
  getPathForFile: (file: File) => string;
  startProjectFileDrag: (workspacePath: string, status: ProjectStatus, projectName: string, paths: string[]) => void;
  onProjectFileDragEnd: (callback: (result: { paths: string[]; clientX: number; clientY: number; insideWindow: boolean }) => void) => () => void;
  onProjectFileOperationProgress: (callback: (progress: ProjectFileOperationProgress) => void) => () => void;
  cancelProjectFileOperation: (operationId: string) => Promise<{ success: boolean; error?: string }>;
  chooseCacheDirectory: () => Promise<{ cancelled?: boolean; path?: string }>;
  chooseWorkspaceDirectory: (currentPath?: string) => Promise<{ success?: boolean; cancelled?: boolean; path?: string }>;
  chooseImportSourceFiles: () => Promise<{ cancelled?: boolean; paths: string[] }>;
  chooseVideoFiles: () => Promise<{ cancelled?: boolean; paths: string[] }>;
  getMediaCacheInfo: (cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; path: string; sizeBytes: number; fileCount: number; error?: string }>;
  clearMediaCache: (cacheConfig?: AppConfig['mediaCache'], olderThanDays?: number) => Promise<{ success: boolean; deletedCount?: number; prunedSourceCount?: number; taskId?: string; error?: string }>;
  getStorageUsageOverview: (force?: boolean) => Promise<StorageUsageOverview>;
  getBackgroundTasks: () => Promise<{ success: boolean; tasks: BackgroundTask[] }>;
  cancelBackgroundTask: (id: string) => Promise<{ success: boolean }>;
  dismissBackgroundTask: (id: string) => Promise<{ success: boolean }>;
  retryBackgroundTask: (id: string) => Promise<{ success: boolean; task?: BackgroundTask; error?: string }>;
  onBackgroundTaskChanged: (callback: (task: BackgroundTask) => void) => () => void;
  chooseBackupTarget: (currentPath?: string) => Promise<{ cancelled: boolean; path?: string }>;
  getBackupStatus: (workspacePath: string) => Promise<BackupStatus>;
  setNasBackupTarget: (targetPath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  saveNasCredential: (request: { remotePath: string; username: string; password: string }) => Promise<{ success: boolean; credentialRef?: string; username?: string; error?: string }>;
  readNasCredential: (credentialRef: string) => Promise<{ success: boolean; credential?: { username: string } | null; error?: string }>;
  deleteNasCredential: (credentialRef: string) => Promise<{ success: boolean; error?: string }>;
  testBackupConnection: () => Promise<{ success: boolean; connection?: BackupConnectionStatus; error?: string }>;
  getBackupSpaceStatus: (workspacePath: string) => Promise<BackupSpaceStatus>;
  cleanupBackup: (workspacePath: string) => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  runBackup: (workspacePath: string, reason?: 'manual' | 'daily' | 'after-import') => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  runBackupIfDue: (workspacePath: string) => Promise<{ success: boolean; skipped?: boolean; error?: string }>;
  verifyBackup: (workspacePath: string, snapshotId: string) => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  restoreBackupWorkspace: (workspacePath: string, snapshotId: string) => Promise<{ success: boolean; cancelled?: boolean; workspacePath?: string; error?: string }>;
  restoreBackupProject: (workspacePath: string, snapshotId: string, projectId: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }>;
  openBackupTarget: () => Promise<{ success: boolean; error?: string }>;
  chooseArchiveTarget: (currentPath?: string) => Promise<{ cancelled: boolean; path?: string }>;
  getArchiveStatus: () => Promise<{ success: boolean; enabled: boolean; state: 'unconfigured' | 'connected' | 'offline'; targetPath?: string; totalBytes?: number; freeBytes?: number; error?: string }>;
  archiveWorkspaceProject: (workspacePath: string, projectName: string) => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  moveArchivedProjectBack: (workspacePath: string, projectName: string, statusAfter?: Exclude<ProjectStatus, '已归档'>) => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  openArchiveTarget: () => Promise<{ success: boolean; error?: string }>;
  openWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, folderName?: string) => Promise<{ success: boolean; error?: string }> ;
  openProjectEntry: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
  getPhotoshopStatus: () => Promise<{ available: boolean }>;
  openProjectEntriesInPhotoshop: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; count?: number; error?: string }>;
  copyProjectEntryPath: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
  getFileIcon: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  importProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, options: { deleteSourceAfterImport: boolean }) => Promise<{ success: boolean; operationId?: string; cancelled?: boolean; count?: number; error?: string }>;
  importProgressFiles: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, options: { deleteSourceAfterImport: boolean; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; trackingEnabled: boolean; trackingState?: ProgressFolder['trackingState']; appendProgressId?: string; progressConflictPolicy?: 'skip' | 'keep-both'; sourcePaths?: string[] }) => Promise<{ success: boolean; operationId?: string; cancelled?: boolean; appended?: boolean; count?: number; skippedCount?: number; skippedNames?: string[]; importedPaths?: string[]; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; requiresDecision?: { kind: 'progress-import-conflict'; names: string[]; conflictCount: number; sourcePaths: string[]; message: string; detail: string }; error?: string }>;
  importBroll: (workspacePath: string, status: ProjectStatus, name: string, options: { splitLargeFiles: boolean; deleteSourceAfterImport: boolean }) => Promise<{ success: boolean; operationId?: string; cancelled?: boolean; count?: number; splitCount?: number; clearedCount?: number; warning?: string; error?: string}>;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}
