import type { IElectronAPI } from '../types';

export type ProjectWorkspaceApiKey =
  | 'addInspirationToProject' | 'adoptVersionTreeFolder' | 'browseFinalVersions' | 'browseProjectFiles'
  | 'browseProjectShortcutPreview' | 'cancelBackgroundTask' | 'cancelListProjectFiles' | 'cancelMediaThumbnail'
  | 'cancelProjectFileCut' | 'cancelRecentProjectFiles' | 'chooseBrollSourceFiles' | 'chooseImportSourceFiles'
  | 'chooseProjectImportFiles' | 'chooseWorkspaceDirectory' | 'commitVersionBatch' | 'copyProjectEntryPath'
  | 'createProjectFolder' | 'createProjectShellNewFile' | 'createVersionGraphEdge' | 'deleteVersionGraphEdge'
  | 'executeManualSelection' | 'exportFinalVersions' | 'extractOfficeImages' | 'extractScreenshotMainImages'
  | 'finalizeSdImportedProjects' | 'getCursorScreenPoint' | 'getFileIcon' | 'getFinalVersionSummary'
  | 'getDrives' | 'getMediaMetadata' | 'getMediaOriginal' | 'getMediaRating' | 'getMediaRatings' | 'getMediaThumbnail' | 'getProjectVideoTimelineFrames'
  | 'getPathForFile' | 'getPhotoshopStatus' | 'getProgressFolders' | 'getProjectContents'
  | 'getProjectEntryDetails' | 'getProjectFileClipboardStatus' | 'getProjectFileDetails' | 'getShellNewFileTypes'
  | 'getTeamProjectWorkspace' | 'getVersionBatchOperations' | 'getWorkspaceProjects' | 'importBroll'
  | 'importProgressFiles' | 'importProjectFiles' | 'inspectProjectToolSources' | 'listProjectFiles'
  | 'listRecentProjectFiles' | 'moveWorkspaceProject' | 'onBackgroundTaskChanged' | 'onProjectFileDragEnd'
  | 'onProjectFileOperationProgress' | 'onThumbnailStateChanged' | 'onWorkspaceFilesChanged' | 'openMediaVersion'
  | 'openProjectEntriesInPhotoshop' | 'openProjectEntry' | 'openWorkspaceProject' | 'preflightManualSelection' | 'materializeProjectExternalLinks'
  | 'projectFileOperation' | 'registerProgressFolder' | 'registerProgressWithGraph' | 'registerTeamProjectPhotos'
  | 'registerVersionBaseline' | 'replaceVersionGraphEdgeSource' | 'resolveProjectShortcut'
  | 'retryVersionBatchOperations' | 'searchProjectFiles' | 'setMediaRating' | 'setWindowFullscreen'
  | 'startProgressTracking' | 'startProjectFileDrag' | 'trackTelemetry' | 'trashWorkspaceProject'
  | 'trimProjectVideo' | 'unwatchFileRoot' | 'updateProgressFolder' | 'updateProgressRelation' | 'watchFileRoot';

export type ProjectWorkspaceApi = Pick<IElectronAPI, ProjectWorkspaceApiKey>;
