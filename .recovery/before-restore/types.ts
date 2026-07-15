export interface Birthday {
  name: string;
  dateStr: string;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export type ToolType = 'dashboard' | 'converter' | 'research' | 'match' | 'rename_tool' | 'video_split';

export interface AppConfig {
  smartImport: {
    autoStart: boolean;
    sdPath: string;
    destPath: string;
    backupEnabled: boolean;
    backupPath: string;
  };
  smartMatch: {
    destFolderName: string;
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
  onLog: (callback: (log: LogEntry) => void) => void;
  getBirthdays: () => Promise<Record<string, string>>;
  saveBirthdays: (data: Record<string, string>) => Promise<{success: boolean, error?: string}>;
  loadConfig: () => Promise<AppConfig | null>;
  saveConfig: (config: AppConfig) => Promise<{success: boolean, error?: string}>;
  getUserPath: () => Promise<string>;
  onUpdateAvailable: (callback: (info: { version: string; url: string; notes: string }) => void) => () => void;
  openExternal: (url: string) => void;
  getDrives: () => Promise<string[]>;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}

export const TYPES_VERSION = "26.5.18";