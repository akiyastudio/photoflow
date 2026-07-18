export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export type ToolType = 'home' | 'project' | 'dashboard' | 'converter' | 'research' | 'match' | 'rename_tool' | 'video_split';

export type Theme = 'light' | 'dark' | 'system';
export type HomeCardId = 'birthday' | 'import' | 'research' | 'converter';
export type ProjectStatus = '策划中' | '待拍摄' | '后期中' | '已归档';
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  策划中: '策划中',
  待拍摄: '待拍摄',
  后期中: '后期中',
  已归档: '已归档'
};
export interface WorkspaceProject { name: string; path: string; status: ProjectStatus; updatedAt: number; }
export interface WorkspaceStatusGroup { status: ProjectStatus; projects: WorkspaceProject[]; }

export interface AppConfig {
  theme: Theme;
  workspacePath: string;
  homeOrder: HomeCardId[];
  birthdayEnabled: boolean;
  mediaCache: {
    maxSizeGB: number;
    directory: string;
    autoCleanup30Days: boolean;
  };
  smartImport: {
    autoStart: boolean;
    sdPath: string;
    sdPaths: string[];
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
  imageConversion: {
    jpgQuality: number;
  };
  smartMatch: {
    imageDestFolderName: string;
    videoDestFolderName: string;
    imageSourceFolderName?: string;
    videoSourceFolderName?: string;
    /** legacy config field */
    destFolderName?: string;
  };
  research: {
    defaultDir: string;
    sensitivity: 'low' | 'standard' | 'high';
    minDuration: number;
    /** legacy config field */
    ssimThreshold?: number;
  };
}

export interface ProjectFileEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: 'folder' | 'image' | 'video' | 'raw' | 'file';
  extension: string;
  size: number;
  updatedAt: number;
  previewUrl?: string;
}

export type ThumbnailState = 'NOT_READY' | 'QUEUED' | 'GENERATING' | 'READY' | 'STALE' | 'FAILED' | 'MISSING';

export interface MediaMetadataField {
  group: string;
  name: string;
  value: string;
}

export interface ProjectFileOperationProgress {
  operationId: string;
  operation: 'paste' | 'trash';
  phase: 'scanning' | 'copying' | 'finishing' | 'trashing' | 'complete' | 'cancelled' | 'failed';
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

export interface IElectronAPI {
  onPythonEvent: any;
  runScript: (scriptName: string, args?: string[]) => void;
  getBirthdays: () => Promise<Record<string, string>>;
  saveBirthdays: (data: Record<string, string>) => Promise<{success: boolean, error?: string}>;
  loadConfig: () => Promise<AppConfig | null>;
  saveConfig: (config: AppConfig) => Promise<{success: boolean, error?: string}>;
  getUserPath: () => Promise<string>;
  onUpdateAvailable: (callback: (info: { version: string; url: string; notes: string }) => void) => () => void;
  openExternal: (url: string) => void;
  checkForUpdates: () => Promise<{ success: boolean; updateAvailable?: boolean; currentVersion?: string; latestVersion?: string; url?: string; notes?: string; error?: string }>;
  getDrives: () => Promise<string[]>;
  setTheme: (theme: Theme) => Promise<void>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  getWorkspaceProjects: (workspacePath: string) => Promise<{ success: boolean; root?: string; statuses: WorkspaceStatusGroup[]; error?: string }> ;
  onWorkspaceFilesChanged: (callback: (change: { root: string; fileName: string }) => void) => () => void;
  createWorkspaceProject: (workspacePath: string, date: string, name: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  renameWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, nextName: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  renameProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, nextName: string) => Promise<{ success: boolean; folder?: { name: string; path: string; updatedAt: number }; error?: string }> ;
  createProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string) => Promise<{ success: boolean; folder?: { name: string; path: string; updatedAt: number }; error?: string }> ;
  undoLastRename: () => Promise<{ success: boolean; message?: string; project?: WorkspaceProject; error?: string }> ;
  moveWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, nextStatus: ProjectStatus) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  archiveImportedProjects: (workspacePath: string) => Promise<{ success: boolean; projects: WorkspaceProject[]; error?: string }>;
  trashWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; operationId?: string; error?: string }>;

  getProjectContents: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; folders: Array<{ name: string; path: string; updatedAt: number }>;error?: string }> ;
  browseProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, relativePath?: string, cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; path?: string; entries: ProjectFileEntry[]; error?: string }>;
  getProjectFileDetails: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; details: Array<{ relativePath: string; size: number; updatedAt: number }>; error?: string }>;
  getMediaThumbnail: (filePath: string, kind: 'image' | 'raw' | 'video', cacheConfig?: AppConfig['mediaCache'], requestedSize?: number, priority?: 0 | 1 | 2 | 3, queueOrder?: number) => Promise<{ success: boolean; state?: ThumbnailState; previewUrl?: string; mediaUrl?: string; usingImportedPreview?: boolean; importedVideoWithoutPreview?: boolean; cacheLayer?: 'memory' | 'disk' | 'source'; error?: string }>;
  cancelMediaThumbnail: (filePath: string, requestedSize?: number) => Promise<{ success: boolean; cancelled: boolean; error?: string }>;
  onThumbnailStateChanged: (callback: (update: { filePath: string; state: ThumbnailState; previewUrls?: Partial<Record<'small' | 'medium' | 'large', string>>; error?: string }) => void) => () => void;
  getMediaOriginal: (filePath: string, kind: 'image' | 'raw', cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; mediaUrl?: string; original?: boolean; orientation?: { matrix: number[]; swapsAxes: boolean; rawOrientation: number; embeddedOrientation: number }; error?: string }>;
  getMediaMetadata: (filePath: string) => Promise<{ success: boolean; fields: MediaMetadataField[]; error?: string }>;
  getVideoHoverPreview: (filePath: string, cacheConfig?: AppConfig['mediaCache'], requestedSize?: number, cacheOnly?: boolean, generateHoverFrames?: boolean) => Promise<{ success: boolean; cached: boolean; complete: boolean; duration: number; frameUrls: string[]; error?: string }>;
  reportRendererError: (message: string, details?: string) => void;
  onAppError: (callback: (message: string) => void) => () => void;
  getRawPreview: (filePath: string, cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; previewUrl?: string; error?: string }>;
  folderHasPng: (folderPath: string) => Promise<{ success: boolean; hasPng?: boolean; error?: string }>;
  projectFileOperation: (workspacePath: string, status: ProjectStatus, projectName: string, operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename' | 'select' | 'move' | 'import', paths: string[], targetRelativePath?: string, nextName?: string, options?: { imageDestFolderName?: string; videoDestFolderName?: string }) => Promise<{ success: boolean; cancelled?: boolean; count?: number; operationId?: string; error?: string }>;
  startProjectFileDrag: (workspacePath: string, status: ProjectStatus, projectName: string, paths: string[]) => void;
  onProjectFileDragEnd: (callback: (result: { paths: string[]; clientX: number; clientY: number; insideWindow: boolean }) => void) => () => void;
  onProjectFileOperationProgress: (callback: (progress: ProjectFileOperationProgress) => void) => () => void;
  cancelProjectFileOperation: (operationId: string) => Promise<{ success: boolean; error?: string }>;
  chooseCacheDirectory: () => Promise<{ cancelled?: boolean; path?: string }>;
  getMediaCacheInfo: (cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; path: string; sizeBytes: number; fileCount: number; error?: string }>;
  clearMediaCache: (cacheConfig?: AppConfig['mediaCache'], olderThanDays?: number) => Promise<{ success: boolean; deletedCount?: number; error?: string }>;
  openWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, folderName?: string) => Promise<{ success: boolean; error?: string }> ;
  openProjectEntry: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
  copyProjectEntryPath: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
  getFileIcon: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  importBroll: (workspacePath: string, status: ProjectStatus, name: string, options: { splitLargeFiles: boolean; clearSource: boolean }) => Promise<{ success: boolean; cancelled?: boolean; count?: number; splitCount?: number; clearedCount?: number; error?: string}>;
  checkCompareFolders: (folderPaths: string[]) => Promise<{ success: boolean; invalidFolders?: Array<{ path: string; files: string[] }>; error?: string }>;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}
