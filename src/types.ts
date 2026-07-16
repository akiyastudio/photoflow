export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export type ToolType = 'home' | 'project' | 'dashboard' | 'converter' | 'research' | 'match' | 'rename_tool' | 'video_split';

export type Theme = 'light' | 'dark' | 'system';
export type HomeCardId = 'birthday' | 'import' | 'research' | 'converter';
export type ProjectStatus = '未策划' | '已策划' | '进行中' | '已归档';
export interface WorkspaceProject { name: string; path: string; status: ProjectStatus; updatedAt: number; }
export interface WorkspaceStatusGroup { status: ProjectStatus; projects: WorkspaceProject[]; }

export interface AppConfig {
  theme: Theme;
  workspacePath: string;
  homeOrder: HomeCardId[];
  smartImport: {
    autoStart: boolean;
    sdPath: string;
    destPath: string;
    backupEnabled: boolean;
    backupPath: string;
    generateVideoPreview: boolean;
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
    /** legacy config field */
    destFolderName?: string;
  };
  research: {
    defaultDir: string;
    ssimThreshold: number;
    minDuration: number;
  };
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
  getWorkspaceProjects: (workspacePath: string) => Promise<{ success: boolean; root?: string; statuses: WorkspaceStatusGroup[]; error?: string }> ;
  onWorkspaceFilesChanged: (callback: (change: { root: string; fileName: string }) => void) => () => void;
  createWorkspaceProject: (workspacePath: string, date: string, name: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  renameWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, nextName: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  renameProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, nextName: string) => Promise<{ success: boolean; folder?: { name: string; path: string; updatedAt: number }; error?: string }> ;
  createProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string) => Promise<{ success: boolean; folder?: { name: string; path: string; updatedAt: number }; error?: string }> ;
  undoLastRename: () => Promise<{ success: boolean; message?: string; project?: WorkspaceProject; error?: string }> ;
  moveWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, nextStatus: ProjectStatus) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  archiveImportedProjects: (workspacePath: string) => Promise<{ success: boolean; projects: WorkspaceProject[]; error?: string }>;
  trashWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; error?: string }>;

  getProjectContents: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; folders: Array<{ name: string; path: string; updatedAt: number }>;error?: string }> ;
  openWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, folderName?: string) => Promise<{ success: boolean; error?: string }> ;
  importBroll: (workspacePath: string, status: ProjectStatus, name: string, options: { splitLargeFiles: boolean; clearSource: boolean }) => Promise<{ success: boolean; cancelled?: boolean; count?: number; splitCount?: number; clearedCount?: number; error?: string}>;
  checkCompareFolders: (folderPaths: string[]) => Promise<{ success: boolean; invalidFolders?: Array<{ path: string; files: string[] }>; error?: string }>;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}
