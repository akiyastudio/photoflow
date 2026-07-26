export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export type ToolType = 'home' | 'project' | 'settings' | 'dashboard' | 'converter' | 'match' | 'video_split';

export type Theme = 'light' | 'dark' | 'system';
export type HomeCardId = 'birthday' | 'import' | 'research' | 'converter';
export type ProjectFileSortField = 'name' | 'date' | 'size';
export type ProjectStatus = '未分类' | '策划中' | '待拍摄' | '后期中' | '已归档';
export interface TeamRetouchComponentSettings {
  useGpu: boolean;
  oversizeCropMode: 'face-centered' | 'expand';
  backendMode: 'auto' | 'basic' | 'advanced';
}
export interface ResearchToolsComponentSettings {
  defaultDir: string;
  sensitivity: 'low' | 'standard' | 'high';
  minDuration: number;
  /** legacy config field */
  ssimThreshold?: number;
}
export interface ComponentSettingsMap {
  'team-retouch'?: TeamRetouchComponentSettings;
  'research-tools'?: ResearchToolsComponentSettings;
  'office-media-extractor'?: Record<string, never>;
  [componentId: string]: unknown;
}
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  未分类: '未分类',
  策划中: '策划中',
  待拍摄: '待拍摄',
  后期中: '后期中',
  已归档: '已归档'
};
export interface ProjectDate {
  year: number;
  month: number;
  day?: number;
  precision: 'month' | 'day';
}
export interface WorkspaceProject { name: string; path: string; status: ProjectStatus; updatedAt: number; projectDate?: ProjectDate; }
export interface WorkspaceStatusGroup { status: ProjectStatus; projects: WorkspaceProject[]; }

export interface AppConfig {
  theme: Theme;
  workspacePath: string;
  autoCleanupDeletedProjectData: boolean;
  createPlanningFolder: boolean;
  defaultFolderSort: ProjectFileSortField;
  homeOrder: HomeCardId[];
  birthdayEnabled: boolean;
  componentSettings: ComponentSettingsMap;
  mediaCache: {
    maxSizeGB: number;
    directory: string;
    autoCleanup30Days: boolean;
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
    splitLargeFiles: boolean;
  };
  brollImport: {
    splitLargeFiles: boolean;
    clearSource: boolean;
  };
  fileImport: {
    preserveOriginal: boolean;
  };
  imageConversion: {
    jpgQuality: number;
  };
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
  /** Compatibility mirror for versions before componentSettings. */
  research: ResearchToolsComponentSettings;
}

export interface ProjectFileEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: 'folder' | 'image' | 'video' | 'raw' | 'file';
  extension: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  previewUrl?: string;
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
  status: 'importing' | 'ready' | 'failed' | string;
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
  trackingEnabled: boolean;
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
  workflowSettings?: {
    preferredIdentityOrder?: string[];
    preferredIdentityId?: string;
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
  matched: boolean;
  accepted: boolean;
  confidence: 'high' | 'medium' | 'low' | 'unmatched' | string;
  score: number;
  margin: number;
  taskId?: string;
  photoId?: string;
  baseVersionId?: string;
  photoName?: string;
  personName?: string;
  alternatives?: Array<{ taskId?: string; photoName?: string; personName?: string; score: number }>;
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
}

export interface ComponentStatus {
  id: 'team-retouch' | 'research-tools' | string;
  name: string;
  description: string;
  capability: string;
  installed: boolean;
  compatible: boolean;
  version: string;
  path: string;
  source: 'application' | 'bundled' | 'development' | 'missing' | string;
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

export interface ProjectFileOperationProgress {
  operationId: string;
  operation: 'paste' | 'trash' | 'import-broll';
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
  onPythonEvent: any;
  runScript: (scriptName: string, args?: string[], requestId?: string) => void;
  cancelPythonTask: (requestId: string) => Promise<{ success: boolean; error?: string }>;
  getBirthdays: () => Promise<Record<string, string>>;
  saveBirthdays: (data: Record<string, string>) => Promise<{success: boolean, error?: string}>;
  loadConfig: () => Promise<AppConfig | null>;
  saveConfig: (config: AppConfig) => Promise<{success: boolean, error?: string}>;
  getUserPath: () => Promise<string>;
  onUpdateAvailable: (callback: (info: { version: string; url: string; notes: string }) => void) => () => void;
  openExternal: (url: string) => void;
  checkForUpdates: () => Promise<{ success: boolean; updateAvailable?: boolean; currentVersion?: string; latestVersion?: string; url?: string; notes?: string; error?: string }>;
  checkScript: (scriptName: string) => Promise<boolean>;
  getComponents: () => Promise<{ success: boolean; components: ComponentStatus[]; installPath: string; error?: string }>;
  openComponentsFolder: (componentId?: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  openLogsFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
  clearLogs: () => Promise<{ success: boolean; deletedCount?: number; error?: string }>;
  clearInterfaceCache: () => Promise<{ success: boolean; clearedBytes?: number; error?: string }>;
  getCursorScreenPoint: () => Promise<{ x: number; y: number }>;
  installComponent: (componentId: string) => Promise<{ success: boolean; cancelled?: boolean; packageSizeBytes?: number; error?: string }>;
  deleteComponentPackage: (kind: 'component' | 'identity-models' | 'advanced', componentId?: string) => Promise<{ success: boolean; deletedBytes?: number; error?: string }>;
  uninstallComponent: (componentId: string) => Promise<{ success: boolean; error?: string }>;
  checkTeamRetouchAdvancedRequirements: () => Promise<{ success: boolean; message?: string; error?: string }>;
  installTeamRetouchAdvanced: (options?: { repair?: boolean }) => Promise<{ success: boolean; cancelled?: boolean; restartRequired?: boolean; packageSizeBytes?: number; error?: string }>;
  uninstallTeamRetouchAdvanced: () => Promise<{ success: boolean; error?: string }>;
  openTeamRetouchIdentityModelsFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
  installTeamRetouchIdentityModels: () => Promise<{ success: boolean; packageSizeBytes?: number; error?: string }>;
  onTeamRetouchAdvancedProgress: (callback: (value: { phase: string; progress?: number; message: string }) => void) => () => void;
  getDrives: () => Promise<string[]>;
  setTheme: (theme: Theme) => Promise<void>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  getWorkspaceProjects: (workspacePath: string) => Promise<{ success: boolean; root?: string; statuses: WorkspaceStatusGroup[]; error?: string }> ;
  onWorkspaceFilesChanged: (callback: (change: { root: string; fileName: string; eventType?: 'rename' | 'change'; reconciled?: boolean }) => void) => () => void;
  onWorkspaceProjectsChanged: (callback: (change: { root: string }) => void) => () => void;
  createWorkspaceProject: (workspacePath: string, date: ProjectDate | null, name: string, options?: { createPlanningFolder?: boolean }) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  renameWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, date: ProjectDate | null, nextName: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  renameProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, nextName: string) => Promise<{ success: boolean; folder?: { name: string; path: string; updatedAt: number }; error?: string }> ;
  createProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, relativePath?: string, makeUnique?: boolean) => Promise<{ success: boolean; folder?: { name: string; path: string; relativePath?: string; updatedAt: number }; error?: string }> ;
  getShellNewFileTypes: (refresh?: boolean) => Promise<{ success: boolean; types: ShellNewFileType[]; error?: string }>;
  createProjectShellNewFile: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, typeId: string) => Promise<{ success: boolean; file?: { name: string; path: string; relativePath: string; extension: string; updatedAt: number }; error?: string }>;
  undoLastRename: (workspacePath?: string) => Promise<{ success: boolean; message?: string; project?: WorkspaceProject; error?: string }> ;
  moveWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, nextStatus: ProjectStatus) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  archiveImportedProjects: (workspacePath: string, projectNames?: string[]) => Promise<{ success: boolean; projects: WorkspaceProject[]; error?: string }>;
  trashWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; operationId?: string; permanent?: boolean; error?: string; errorCode?: string }>;
  cleanupDeletedWorkspaceProjects: (workspacePath: string) => Promise<{ success: boolean; checkedCount: number; cleanedCount: number; outcomes: Array<{ projectId: string; name: string; cleaned: boolean; status: 'in_recycle_bin' | 'missing' | 'restored' | 'unknown'; removedArtifactCount?: number }>; error?: string }>;

  getProjectContents: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; folders: Array<{ name: string; path: string; updatedAt: number }>;error?: string }> ;
  browseProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, relativePath?: string, cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; path?: string; entries: ProjectFileEntry[]; missingDirectory?: boolean; error?: string }>;
  extractOfficeImages: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; documentCount?: number; successfulCount?: number; failedCount?: number; imageCount?: number; results: Array<{ document: string; documentName: string; success: boolean; count: number; totalBytes?: number; outputFolder?: string; files?: string[]; message?: string; error?: string }>; error?: string }>;
  getProjectFileDetails: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; details: Array<{ relativePath: string; size: number; createdAt: number; updatedAt: number }>; error?: string }>;
  getProjectEntryDetails: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; details?: { size: number; createdAt: number; updatedAt: number; fileCount: number; folderCount: number }; error?: string }>;
  getMediaVersions: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<MediaVersionBundle>;
  updateMediaVersion: (workspacePath: string, request: { versionId: string; versionName?: string; note?: string; isFinal?: boolean; makeCurrent?: boolean }) => Promise<MediaVersionBundle>;
  relocateMediaVersion: (workspacePath: string, status: ProjectStatus, name: string, request: { photoId: string; versionId: string }) => Promise<MediaVersionBundle>;
  deleteMediaVersion: (workspacePath: string, request: { photoId: string; versionId: string; trashFile?: boolean }) => Promise<MediaVersionBundle>;
  getMediaVersionDeleteScope: (workspacePath: string, versionId: string) => Promise<{ success: boolean; versionNumber: number; versionCount: number; missingCount: number; allMissing: boolean; childCount: number; selectedChildCount: number; error?: string }>;
  deleteProjectMissingMediaVersion: (workspacePath: string, versionId: string) => Promise<{ success: boolean; deletedCount: number; versionNumber?: number; reparentedCount?: number; removedArtifactCount?: number; error?: string }>;
  recordMediaVersionCompare: (workspacePath: string, request: { photoId: string; leftVersionId: string; rightVersionId: string; compareMode: string }) => Promise<{ success: boolean; error?: string }>;
  openMediaVersion: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  getProgressFolders: (workspacePath: string, projectName: string) => Promise<{ success: boolean; progressFolders: ProgressFolder[]; error?: string }>;
  ensureSelectionBaseline: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; registered: boolean; count: number; progressFolder?: ProgressFolder; batch?: VersionBatch; error?: string }>;
  getFinalVersionSummary: (workspacePath: string, projectName: string) => Promise<{ success: boolean; count: number; availableCount: number; missingCount: number; error?: string }>;
  browseFinalVersions: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; count: number; availableCount: number; missingCount: number; entries: ProjectFileEntry[]; error?: string }>;
  exportFinalVersions: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; count: number; displayName?: string; versionKey?: string; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  createProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; displayName: string }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  registerProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { relativePath: string; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; displayName: string; trackingEnabled: boolean; progressId?: string }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; error?: string }>;
  registerVersionBaseline: (workspacePath: string, status: ProjectStatus, projectName: string, relativePath: string) => Promise<{ success: boolean; batch?: VersionBatch; error?: string }>;
  compareVersionFolders: (workspacePath: string, status: ProjectStatus, projectName: string, referenceRelativePath: string, sourceRelativePath: string) => Promise<{ success: boolean; matches: Array<{ source: string; reference: string; target: string; confidence: string; distance: number }>; suggestions: Array<{ source: string; reference: string; target: string; confidence: string; distance: number }>; unmatched: string[]; unmatchedReference: string[]; error?: string }>;
  commitVersionBatch: (workspacePath: string, status: ProjectStatus, projectName: string, request: { folderA: string; folderB: string; importKey: string; displayName?: string; renameSources?: boolean; copyMissingReferences?: string[]; matches: Array<{ reference: string; source: string; target?: string; distance: number; confidence: string }> }) => Promise<{ success: boolean; alreadyCommitted?: boolean; referenceBatch?: VersionBatch; batch?: VersionBatch; renamedCount?: number; renameErrors?: Array<{ source: string; target: string; error: string }>; copiedMissingCount?: number; copyMissingErrors?: Array<{ name: string; error: string }>; error?: string }>;
  getTeamPatches: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<TeamPatchBundle>;
  getTeamProjectWorkspace: (workspacePath: string, name: string) => Promise<TeamIdentityWorkspace>;
  getTeamIdentitySimilarities: (workspacePath: string, name: string) => Promise<{ success: boolean; similarities: NonNullable<TeamIdentityWorkspace['similarities']>; error?: string }>;
  registerTeamProjectPhotos: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<TeamIdentityWorkspace>;
  suggestTeamIdentities: (workspacePath: string, name: string) => Promise<TeamIdentityWorkspace & { suggestedCount?: number; candidateGroupCount?: number; unmatchedCount?: number; method?: string; faceBackend?: string; bodyBackend?: string; provider?: string }>;
  saveTeamIdentity: (workspacePath: string, request: { projectName: string; identityId?: string; name: string; assignments?: Array<{ photoId: string; baseVersionId: string; personIndex: number; confidence?: number; source?: string; completed?: boolean }> }) => Promise<{ success: boolean; identityId?: string; error?: string }>;
  assignTeamIdentity: (workspacePath: string, request: { projectName: string; photoId: string; baseVersionId: string; personIndex: number; identityId?: string; confidence?: number; source?: string; completed?: boolean }) => Promise<{ success: boolean; error?: string }>;
  confirmTeamIdentityGroup: (workspacePath: string, request: { projectName: string; anchorSubjectKey: string; identityId?: string; name?: string; assignments: Array<{ photoId: string; baseVersionId: string; personIndex: number; confidence?: number }> }) => Promise<TeamIdentityWorkspace & { identityId?: string; updatedCount?: number; autoReleasedCount?: number }>;
  completeTeamIdentity: (workspacePath: string, request: { photoId: string; baseVersionId: string; personIndex: number; completed: boolean }) => Promise<{ success: boolean; error?: string }>;
  deleteTeamIdentity: (workspacePath: string, request: { projectName: string; identityId: string }) => Promise<{ success: boolean; error?: string }>;
  saveTeamWorkflowSettings: (workspacePath: string, request: { projectName: string; preferredIdentityOrder?: string[]; preferredIdentityId?: string }) => Promise<{ success: boolean; workflowSettings?: { preferredIdentityOrder?: string[]; preferredIdentityId?: string }; error?: string }>;
  excludeTeamPerson: (workspacePath: string, status: ProjectStatus, projectName: string, request: { photoId: string; baseVersionId: string; personIndex: number; backendMode?: 'auto' | 'basic' | 'advanced' }) => Promise<TeamIdentityWorkspace & TeamPatchBundle & { removedPersonCount?: number; workflowRefreshCount?: number; warning?: string; error?: string }>;
  removeProjectTeamPhoto: (workspacePath: string, request: { photoId: string; baseVersionId: string }) => Promise<{ success: boolean; removedArtifactCount?: number; error?: string }>;
  generateTeamWorkflow: (workspacePath: string, status: ProjectStatus, name: string, request: { replace?: boolean; preferredIdentityOrder?: string[]; preferredIdentityId?: string; groups: Array<{ week: number; identityId: string; identityName: string; items: Array<{ photoId: string; baseVersionId: string; personIndex: number; taskId: string; photoName: string }> }> }) => Promise<{ success: boolean; requiresConfirmation?: boolean; count?: number; groupCount?: number; path?: string; error?: string }>;
  exportTeamIdentityTasks: (workspacePath: string, status: ProjectStatus, name: string, request: { week: number; identityId: string }) => Promise<{ success: boolean; count?: number; path?: string; error?: string }>;
  returnTeamWorkflowBatch: (workspacePath: string, name: string, request: { status: ProjectStatus; returnedFiles: string[]; items: Array<{ photoId: string; baseVersionId: string; personIndex: number; taskId: string; taskOrder: number[] }> }) => Promise<TeamPatchReturnBatchResult>;
  detectTeamPatchPeople: (workspacePath: string, status: ProjectStatus, name: string, request: { photoId: string; baseVersionId: string; backendMode?: 'auto' | 'basic' | 'advanced'; restoreExcluded?: boolean }) => Promise<TeamPatchBundle>;
  onTeamPatchDetectionProgress: (callback: (value: { photoId: string; baseVersionId: string; progress: number; message: string }) => void) => () => void;
  detectTeamPatchBatch: (workspacePath: string, status: ProjectStatus, name: string, request: { relativePaths: string[]; backendMode?: 'auto' | 'basic' | 'advanced' }) => Promise<{ success: boolean; persistentBackend?: boolean; requestedMode?: string; advancedUsedCount?: number; fallbackCount?: number; results: Array<{ relativePath: string; name: string; success: boolean; photoId?: string; baseVersionId?: string; personCount?: number; workTileCount?: number; deliveryDirectory?: string; detector?: string; fallbackReason?: string; error?: string }>; error?: string }>;
  onTeamPatchBatchProgress: (callback: (value: { itemIndex: number; itemCount: number; relativePath: string; itemName: string; progress: number; message: string }) => void) => () => void;
  updateTeamPatch: (workspacePath: string, request: { photoId?: string; taskId: string; status?: ProjectStatus; projectName?: string; personName?: string; assignee?: string; crop?: { x: number; y: number; width: number; height: number }; needsReview?: boolean; reviewReason?: string }) => Promise<{ success: boolean; tasks: TeamPatchTask[]; workflowRefreshCount?: number; warning?: string; error?: string }>;
  deleteTeamPatch: (workspacePath: string, request: { photoId: string; taskId: string }) => Promise<{ success: boolean; tasks: TeamPatchTask[]; removedArtifactCount?: number; error?: string }>;
  cleanupTeamPatches: (workspacePath: string, request: { photoId: string; baseVersionId: string }) => Promise<TeamPatchBundle & { removedArtifactCount?: number }>;
  uploadTeamPatch: (workspacePath: string, request: { photoId: string; taskId: string; personIndex?: number; projectName?: string; status?: ProjectStatus }) => Promise<{ success: boolean; cancelled?: boolean; tasks: TeamPatchTask[]; error?: string }>;
  removeTeamPatchUpload: (workspacePath: string, request: { photoId: string; taskId: string }) => Promise<{ success: boolean; tasks: TeamPatchTask[]; removedArtifactCount?: number; error?: string }>;
  selectTeamPatchReturns: (projectName: string) => Promise<{ success: boolean; cancelled?: boolean; files?: string[]; error?: string }>;
  returnTeamPatchBatch: (workspacePath: string, status: ProjectStatus, name: string, request: { relativePaths: string[]; returnedFiles?: string[]; outputProgressId?: string }) => Promise<TeamPatchReturnBatchResult>;
  onTeamPatchReturnBatchProgress: (callback: (value: { phase: 'matching' | 'importing' | 'merging' | 'complete' | string; progress: number; message: string }) => void) => () => void;
  openTeamPatch: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  openTeamPatchFolder: (filePath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  mergeTeamPatches: (workspacePath: string, status: ProjectStatus, name: string, request: { photoId: string; baseVersionId: string; outputProgressId: string; versionName?: string }) => Promise<TeamPatchBundle>;
  getMediaThumbnail: (filePath: string, kind: 'image' | 'raw' | 'video', cacheConfig?: AppConfig['mediaCache'], requestedSize?: number, priority?: 0 | 1 | 2 | 3, queueOrder?: number) => Promise<{ success: boolean; taskId?: string; state?: ThumbnailState; previewUrl?: string; mediaUrl?: string; usingImportedPreview?: boolean; importedVideoWithoutPreview?: boolean; cacheLayer?: 'memory' | 'disk' | 'source'; error?: string }>;
  cancelMediaThumbnail: (filePath: string, requestedSize?: number) => Promise<{ success: boolean; cancelled: boolean; error?: string }>;
  onThumbnailStateChanged: (callback: (update: { filePath: string; state: ThumbnailState; previewUrls?: Partial<Record<'small' | 'medium' | 'large', string>>; error?: string }) => void) => () => void;
  getMediaOriginal: (filePath: string, kind: 'image' | 'raw', cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; mediaUrl?: string; original?: boolean; orientation?: { matrix: number[]; swapsAxes: boolean; rawOrientation: number; embeddedOrientation: number }; error?: string }>;
  getMediaMetadata: (filePath: string) => Promise<{ success: boolean; fields: MediaMetadataField[]; error?: string }>;
  reportRendererError: (message: string, details?: string) => void;
  onAppError: (callback: (message: string) => void) => () => void;
  getRawPreview: (filePath: string, cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; previewUrl?: string; error?: string }>;
  folderHasPng: (folderPath: string) => Promise<{ success: boolean; hasPng?: boolean; error?: string }>;
  projectFileOperation: (workspacePath: string, status: ProjectStatus, projectName: string, operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename' | 'select' | 'move' | 'import', paths: string[], targetRelativePath?: string, nextName?: string, options?: { imageDestFolderName?: string; videoDestFolderName?: string; renameNames?: string[] }) => Promise<{ success: boolean; cancelled?: boolean; count?: number; permanentCount?: number; imageCount?: number; videoCount?: number; operationId?: string; replacedCount?: number; replacedNames?: string[]; replacedPermanentCount?: number; replacedRetainedCount?: number; error?: string; errorCode?: string }>;
  getProjectFileClipboardStatus: () => Promise<{ success: boolean; hasFiles: boolean; error?: string }>;
  startProjectFileDrag: (workspacePath: string, status: ProjectStatus, projectName: string, paths: string[]) => void;
  onProjectFileDragEnd: (callback: (result: { paths: string[]; clientX: number; clientY: number; insideWindow: boolean }) => void) => () => void;
  onProjectFileOperationProgress: (callback: (progress: ProjectFileOperationProgress) => void) => () => void;
  cancelProjectFileOperation: (operationId: string) => Promise<{ success: boolean; error?: string }>;
  chooseCacheDirectory: () => Promise<{ cancelled?: boolean; path?: string }>;
  chooseWorkspaceDirectory: (currentPath?: string) => Promise<{ cancelled?: boolean; path?: string }>;
  getMediaCacheInfo: (cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; path: string; sizeBytes: number; fileCount: number; error?: string }>;
  clearMediaCache: (cacheConfig?: AppConfig['mediaCache'], olderThanDays?: number) => Promise<{ success: boolean; deletedCount?: number; prunedSourceCount?: number; taskId?: string; error?: string }>;
  getBackgroundTasks: () => Promise<{ success: boolean; tasks: BackgroundTask[] }>;
  cancelBackgroundTask: (id: string) => Promise<{ success: boolean }>;
  retryBackgroundTask: (id: string) => Promise<{ success: boolean; task?: BackgroundTask; error?: string }>;
  onBackgroundTaskChanged: (callback: (task: BackgroundTask) => void) => () => void;
  openWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, folderName?: string) => Promise<{ success: boolean; error?: string }> ;
  openProjectEntry: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
  getPhotoshopStatus: () => Promise<{ available: boolean }>;
  openProjectEntriesInPhotoshop: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; count?: number; error?: string }>;
  copyProjectEntryPath: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
  getFileIcon: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  importProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, options: { preserveOriginal: boolean }) => Promise<{ success: boolean; cancelled?: boolean; count?: number; error?: string }>;
  importProgressFiles: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, options: { preserveOriginal: boolean; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; trackingEnabled: boolean }) => Promise<{ success: boolean; cancelled?: boolean; count?: number; importedPaths?: string[]; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  importBroll: (workspacePath: string, status: ProjectStatus, name: string, options: { splitLargeFiles: boolean; preserveOriginal: boolean }) => Promise<{ success: boolean; operationId?: string; cancelled?: boolean; count?: number; splitCount?: number; clearedCount?: number; warning?: string; error?: string}>;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}
