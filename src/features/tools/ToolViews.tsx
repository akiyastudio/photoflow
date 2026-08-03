import React, { useState, useEffect, useMemo } from 'react';
import { FolderInput, ScanSearch, HardDrive, Play, Trash2, AlertCircle, Edit, X, Plus, User, Loader2, RotateCcw, Download, Scissors, Video, ChevronDown, ChevronUp, Crop, CheckCircle2 } from 'lucide-react';
import { TaskProgress } from '../../components/TaskStatus';
import type { AppConfig, LogEntry, ProjectStatus, WorkspaceProject } from '../../types';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useEscapeLayer } from '../../components/LayerProvider';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../../utils/recycleBinFailure';
import { InteractiveCropEditor, type CropRectangle } from '../../components/InteractiveCropEditor';

const IMAGE_SELECTION_FOLDER_NAME = '图片选片';
const VIDEO_SELECTION_FOLDER_NAME = '视频选片';
interface PythonEvent {
  type: 'log' | 'error' | 'progress' | 'status' | 'ask_user' | 'success' | 'warning' | 'preview' | 'cancelled' | 'complete';
  message: string;
  data?: any;
  progress?: number;
  scriptName?: string;
  requestId?: string;
}

type ImportTransferStats = {
  bytesCopied: number;
  totalBytes: number;
  bytesPerSecond: number;
  filesCopied?: number;
  totalFiles?: number;
};

const formatTransferBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};
const importCountBucket = (count: number) => count <= 20
  ? '1-20'
  : count <= 100
    ? '21-100'
    : count <= 500
      ? '101-500'
      : count <= 2000
        ? '501-2000'
        : '2001+';

const usePythonTask = (scriptName: string, initialStatus: string) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState(initialStatus);
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const requestIdRef = React.useRef('');
  const taskHadErrorRef = React.useRef(false);
  const taskHadSuccessRef = React.useRef(false);
  const taskCancelledRef = React.useRef(false);
  const taskAwaitingPreviewRef = React.useRef(false);
  const pendingLogsRef = React.useRef<LogEntry[]>([]);
  const logFlushTimerRef = React.useRef<number | null>(null);
  const appendLog = React.useCallback((message: string, type: LogEntry['type']) => {
    pendingLogsRef.current.push({ timestamp: new Date().toLocaleTimeString(), message, type });
    if (logFlushTimerRef.current !== null) return;
    logFlushTimerRef.current = window.setTimeout(() => {
      const pending = pendingLogsRef.current.splice(0);
      logFlushTimerRef.current = null;
      if (pending.length) setLogs(previous => [...previous, ...pending].slice(-200));
    }, 100);
  }, []);

  useEffect(() => () => {
    if (logFlushTimerRef.current !== null) window.clearTimeout(logFlushTimerRef.current);
    pendingLogsRef.current = [];
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    return window.electronAPI.onPythonEvent((event: PythonEvent) => {
      if (event.scriptName !== scriptName) return;
      if (!requestIdRef.current || event.requestId !== requestIdRef.current) return;
      if (event.type === 'log' || event.type === 'error' || event.type === 'warning' || event.type === 'success') {
        const type: LogEntry['type'] = event.type === 'log' ? 'info' : event.type;
        appendLog(event.message, type);
        if (event.type === 'success') {
          taskHadSuccessRef.current = true;
          setProgress(100);
          setStatusMsg('正在结束任务…');
        } else if (event.type === 'error') {
          taskHadErrorRef.current = true;
          setStatusMsg('出现错误，正在结束任务…');
        }
      } else if (event.type === 'progress') {
        if (event.progress !== undefined) setProgress(event.progress);
        if (event.message) setStatusMsg(event.message);
        if (event.data?.fileStarted && event.message) appendLog(event.message, 'info');
      } else if (event.type === 'status') {
        if (event.message) setStatusMsg(event.message);
      } else if (event.type === 'preview') {
        taskAwaitingPreviewRef.current = true;
        setPreview(event.data || {});
        setIsRunning(false);
        setStatusMsg('等待确认');
      } else if (event.type === 'cancelled') {
        taskCancelledRef.current = true;
        appendLog(event.message || '任务已取消。', 'warning');
        setIsRunning(false);
        setIsCancelling(false);
        setProgress(0);
        setStatusMsg('已取消并回滚');
      } else if (event.type === 'complete') {
        if (taskCancelledRef.current || taskAwaitingPreviewRef.current) return;
        const exitCode = event.data?.exitCode;
        const failed = exitCode !== 0 || (taskHadErrorRef.current && !taskHadSuccessRef.current);
        setIsRunning(false);
        setIsCancelling(false);
        if (failed) {
          setStatusMsg('发生错误');
        } else {
          setProgress(100);
          setStatusMsg('处理完成');
        }
      }
    });
  }, [appendLog, scriptName]);

  const start = (args: string[], startingStatus: string) => {
    if (isRunning) return false;
    if (logFlushTimerRef.current !== null) window.clearTimeout(logFlushTimerRef.current);
    logFlushTimerRef.current = null;
    pendingLogsRef.current = [];
    setLogs([]);
    taskHadErrorRef.current = false;
    taskHadSuccessRef.current = false;
    taskCancelledRef.current = false;
    taskAwaitingPreviewRef.current = false;
    setPreview(null);
    setProgress(0);
    setIsRunning(true);
    setIsCancelling(false);
    setStatusMsg(startingStatus);
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    requestIdRef.current = requestId;
    window.electronAPI.runScript(scriptName, args, requestId);
    return true;
  };

  const cancel = async () => {
    if (!isRunning || !requestIdRef.current || isCancelling) return false;
    setIsCancelling(true);
    setStatusMsg('正在取消并回滚……');
    const result = await window.electronAPI.cancelPythonTask(requestIdRef.current);
    if (!result.success) {
      setIsCancelling(false);
      appendLog(result.error || '无法取消任务。', 'error');
    }
    return result.success;
  };

  return { logs, isRunning, isCancelling, progress, statusMsg, preview, clearPreview: () => setPreview(null), start, cancel };
};

const ImportCard = ({ config, drives = [], destinationPath, brollDestinationPath, workspaceProjects, active = true, directSource = false, deleteSourceAfterImport = true, generateJpgFromRaw = false, splitLargeBrollFiles = false, onBusyChange, onImportConfigChange, onImportComplete, completedActionLabel = '继续导入', onCompletedAction }: { config?: AppConfig['smartImport'], drives?: string[], destinationPath?: string | null, brollDestinationPath?: string | null, workspaceProjects?: WorkspaceProject[], active?: boolean, directSource?: boolean, deleteSourceAfterImport?: boolean, generateJpgFromRaw?: boolean, splitLargeBrollFiles?: boolean, onBusyChange?: (busy: boolean) => void, onImportConfigChange?: (config: AppConfig['smartImport']) => void, onImportComplete?: (projectNames: string[]) => void, completedActionLabel?: string, onCompletedAction?: () => void }) => {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready_to_import' | 'importing' | 'decision' | 'processing' | 'completed'>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("等待连接...");
  const [decisionData, setDecisionData] = useState<any>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [transferStats, setTransferStats] = useState<ImportTransferStats | null>(null);
  const [completedProjectNames, setCompletedProjectNames] = useState<string[]>([]);
  const [isCancellingImport, setIsCancellingImport] = useState(false);
  const [shouldDeleteSourceAfterImport, setShouldDeleteSourceAfterImport] = useState(deleteSourceAfterImport);
  const selectedDrives = config?.sdPaths?.length ? config.sdPaths : config?.sdPath ? [config.sdPath] : [];
  const driveTypes = config?.sdDriveTypes || {};
  // 【关键修改】使用 Ref 来做“防抖”锁，防止 SD 卡接触不良导致多次触发 startImport
  const isBusyRef = React.useRef(false);
  const importQueueRef = React.useRef<Array<{ path: string; type: 'work' | 'broll' }>>([]);
  const currentDriveRef = React.useRef('');
  const currentDriveTypeRef = React.useRef<'work' | 'broll'>('work');
  const importRequestIdRef = React.useRef('');
  const currentStageRef = React.useRef('');
  const cancelRequestedRef = React.useRef(false);
  const stagingCompleteRef = React.useRef(false);
  const importedProjectNamesRef = React.useRef<string[]>([]);
  const completedDriveCountRef = React.useRef(0);
  const failedDrivesRef = React.useRef<string[]>([]);
  const skippedDrivesRef = React.useRef<string[]>([]);
  const drivesRef = React.useRef(drives);
  const driveImportSessionsRef = React.useRef(new Map<string, string>());
  const currentImportSessionKeyRef = React.useRef('');
  const retryDrivePathsRef = React.useRef<string[]>([]);
  const currentImportSessionRef = React.useRef('');
  const continueAfterDriveFailureRef = React.useRef<(drive: string, message: string, requestId?: string) => void>(() => undefined);
  const continueRoutedImportRef = React.useRef<(routes: Record<string, string>) => void>(() => undefined);
  const startImportRef = React.useRef<(sdPath?: string, type?: 'work' | 'broll') => void>(() => undefined);
  const startBatchRef = React.useRef<() => void>(() => undefined);
  const onImportCompleteRef = React.useRef(onImportComplete);
  useEffect(() => { onImportCompleteRef.current = onImportComplete; }, [onImportComplete]);
  useEffect(() => { drivesRef.current = drives; }, [drives]);
  const importSessionStorageKey = 'photoflow:sd-import-sessions:v1';
  const readPersistedImportSessions = () => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(importSessionStorageKey) || '{}') as Record<string, string | { session?: string; stagingComplete?: boolean }>;
      return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? { session: value, stagingComplete: false } : { session: String(value?.session || ''), stagingComplete: value?.stagingComplete === true }])) as Record<string, { session: string; stagingComplete: boolean }>;
    }
    catch { return {}; }
  };
  const persistImportSession = (key: string, session: string, stagingComplete?: boolean) => {
    const sessions = readPersistedImportSessions();
    if (session) sessions[key] = { session, stagingComplete: stagingComplete ?? sessions[key]?.stagingComplete ?? false };
    else delete sessions[key];
    window.localStorage.setItem(importSessionStorageKey, JSON.stringify(sessions));
  };
  const importDestinationForType = (type: 'work' | 'broll') => workspaceProjects !== undefined ? destinationPath : type === 'broll' ? brollDestinationPath : destinationPath;
  const importSessionKeyFor = (sdPath: string, type: 'work' | 'broll') => {
    const resolvedDestinationPath = importDestinationForType(type);
    return resolvedDestinationPath ? `${resolvedDestinationPath}\u0000${sdPath}\u0000${type}` : '';
  };
  const hasPersistedImportSession = (sdPath: string, type: 'work' | 'broll') => {
    const key = importSessionKeyFor(sdPath, type);
    return Boolean(key && readPersistedImportSessions()[key]?.stagingComplete);
  };
  continueAfterDriveFailureRef.current = (failedDrive, message, requestId = '') => {
    if (failedDrive && !failedDrivesRef.current.includes(failedDrive)) failedDrivesRef.current.push(failedDrive);
    currentDriveRef.current = '';
    currentStageRef.current = '';
    currentImportSessionRef.current = '';
    currentImportSessionKeyRef.current = '';
    importRequestIdRef.current = '';
    stagingCompleteRef.current = false;
    cancelRequestedRef.current = false;
    setDecisionData(null);
    setTransferStats(null);
    setIsCancellingImport(false);

    let nextDrive = importQueueRef.current.shift();
    while (nextDrive && !drivesRef.current.includes(nextDrive.path) && !hasPersistedImportSession(nextDrive.path, nextDrive.type)) {
      if (!failedDrivesRef.current.includes(nextDrive.path)) failedDrivesRef.current.push(nextDrive.path);
      nextDrive = importQueueRef.current.shift();
    }

    const continueBatch = () => {
      if (nextDrive) {
        // Release only the in-memory start guard; the visible status remains
        // busy while the next connected card is queued.
        isBusyRef.current = false;
        setStatus('processing');
        setProgress(0);
        setStatusMsg(`${message}；继续导入 ${nextDrive.path}`);
        window.setTimeout(() => startImportRef.current(nextDrive!.path, nextDrive!.type), 300);
        return;
      }
      isBusyRef.current = false;
      const failedLabel = failedDrivesRef.current.join('、');
      retryDrivePathsRef.current = [...failedDrivesRef.current];
      if (completedDriveCountRef.current > 0) {
        const completedProjectNames = importedProjectNamesRef.current;
        setStatus('completed');
        setProgress(100);
        setCompletedProjectNames(completedProjectNames);
        setStatusMsg(`批量导入已结束：${completedDriveCountRef.current} 张卡完成，${failedLabel} 未完成，可重新插卡后续传`);
        onImportCompleteRef.current?.(completedProjectNames);
      } else {
        setStatus('idle');
        setProgress(0);
        setStatusMsg(`${message}；已完成的暂存文件会保留，重新插卡后可续传`);
      }
    };

    if (requestId) {
      void window.electronAPI.cancelPythonTask(requestId).finally(continueBatch);
    } else {
      continueBatch();
    }
  };
  const resetCompletedImport = React.useCallback(() => {
    setStatus('idle');
    setProgress(0);
    setStatusMsg('等待连接...');
    setDecisionData(null);
    setTransferStats(null);
    setCompletedProjectNames([]);
    setLogs([]);
    setIsCancellingImport(false);
  }, []);
  useEffect(() => {
    if (!active && status === 'completed') resetCompletedImport();
  }, [active, resetCompletedImport, status]);
  useEffect(() => {
    if (!active || isBusyRef.current) return;
    setShouldDeleteSourceAfterImport(deleteSourceAfterImport);
  }, [active, deleteSourceAfterImport]);
  useEffect(() => {
    const busy = status === 'ready_to_import' || status === 'importing' || status === 'decision' || status === 'processing';
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [status, onBusyChange]);
  useEffect(() => {
    if (directSource || !isBusyRef.current || stagingCompleteRef.current) return;
    const currentDrive = currentDriveRef.current;
    if (!currentDrive || drives.includes(currentDrive)) return;

    const disconnectTimer = window.setTimeout(() => {
      if (!isBusyRef.current || stagingCompleteRef.current || drives.includes(currentDrive) || currentDriveRef.current !== currentDrive) return;
      const activeRequestId = status === 'decision' ? '' : importRequestIdRef.current;
      continueAfterDriveFailureRef.current(currentDrive, `设备 ${currentDrive} 已断开`, activeRequestId);
    }, 1200);

    return () => window.clearTimeout(disconnectTimer);
  }, [decisionData?.stagingComplete, directSource, drives, status]);
  const toggleDrive = (sdPath: string) => {
    if (!config || !onImportConfigChange) return;
    retryDrivePathsRef.current = [];
    const sdPaths = selectedDrives.includes(sdPath) ? selectedDrives.filter(path => path !== sdPath) : [...selectedDrives, sdPath];
    onImportConfigChange({ ...config, sdPath: sdPaths[0] || '', sdPaths, sdDriveTypes: { ...driveTypes, [sdPath]: driveTypes[sdPath] || 'work' } });
  };
  const setDriveType = (sdPath: string, type: 'work' | 'broll') => {
    if (!config || !onImportConfigChange) return;
    onImportConfigChange({ ...config, sdDriveTypes: { ...driveTypes, [sdPath]: type } });
  };

  const runCmd = (stage: string, args: string[] = []) => {
    currentStageRef.current = stage;
    const sessionArgs = ['plan', 'import', 'broll'].includes(stage) ? ['--import_session', currentImportSessionRef.current || importRequestIdRef.current] : [];
    const dateFilterArgs = !directSource && ['plan', 'import', 'broll'].includes(stage) && config?.dateFilter && config.dateFilter !== 'all'
      ? ['--date_filter', config.dateFilter]
      : [];
    if(window.electronAPI) window.electronAPI.runScript('classify.py', ['--stage', stage, ...args, ...sessionArgs, ...dateFilterArgs, ...(directSource ? ['--direct_source', '--source_paths', JSON.stringify(selectedDrives)] : []), ...(shouldDeleteSourceAfterImport ? ['--delete_source'] : []), ...(generateJpgFromRaw ? ['--generate_jpg_from_raw'] : [])], importRequestIdRef.current);
  };

  const cancelImport = async () => {
    if (isCancellingImport || !isBusyRef.current) return;
    setIsCancellingImport(true);
    importQueueRef.current = [];
    if (status === 'decision') {
      const usesProjectRouting = workspaceProjects !== undefined;
      const resolvedDestinationPath = usesProjectRouting ? destinationPath : currentDriveTypeRef.current === 'broll' ? brollDestinationPath : destinationPath;
      const discardSession = currentImportSessionRef.current;
      if (resolvedDestinationPath && discardSession) {
        window.electronAPI.runScript('classify.py', ['--stage', 'discard', '--dest_path', resolvedDestinationPath, '--import_session', discardSession], crypto.randomUUID());
      }
      if (currentImportSessionKeyRef.current) {
        driveImportSessionsRef.current.delete(currentImportSessionKeyRef.current);
        persistImportSession(currentImportSessionKeyRef.current, '');
      }
      cancelRequestedRef.current = true;
      currentDriveRef.current = '';
      currentImportSessionRef.current = '';
      currentImportSessionKeyRef.current = '';
      isBusyRef.current = false;
      setStatus('idle');
      setStatusMsg('导入已取消');
      setIsCancellingImport(false);
      return;
    }
    const result = await window.electronAPI.cancelPythonTask(importRequestIdRef.current);
    if (!result.success) {
      setIsCancellingImport(false);
      setStatusMsg(result.error || '无法取消当前导入任务');
    }
  };

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;

    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      if (!active && !isBusyRef.current) return;
      if (event.scriptName !== 'classify.py') return;
      if (!event.requestId || event.requestId !== importRequestIdRef.current) return;
      if (cancelRequestedRef.current && event.type !== 'cancelled') return;
      // 1. 记录日志
      if (event.message) {
        setLogs(prev => {
           // 简单的去重逻辑，防止同样的日志刷屏
           const last = prev[prev.length - 1];
           if (last && last.message === event.message && event.type === 'progress') return prev;

           return [...prev, {
            timestamp: new Date().toLocaleTimeString(),
            message: event.message,
            type: event.type as any
           }];
        });
      }

      // 2. 处理事件
      switch (event.type) {
        case 'status':
          // 只有当状态是 idle 或 checking 时，才允许响应连接信号
          if (event.data?.connected) {
            // 【关键判断】如果当前正在忙（正在导入或处理），直接忽略这次信号
            if (isBusyRef.current) return;

            setStatus('ready_to_import');
            setStatusMsg("检测到设备: " + event.data.path);

            // 延迟一点启动，给 UI 一个反应时间
            setTimeout(() => {
                if (!isBusyRef.current) {
                    startBatchRef.current();
                }
            }, 500);
          } else {
             // 只有在非运行状态下才重置为 idle，防止导入过程中拔卡导致界面重置
             if (!isBusyRef.current) {
                setStatus('idle');
                setStatusMsg("未检测到 SD 卡");
             }
          }
          break;

        case 'progress':
          if (event.data?.stagingComplete) {
            stagingCompleteRef.current = true;
            if (currentImportSessionKeyRef.current && currentImportSessionRef.current) persistImportSession(currentImportSessionKeyRef.current, currentImportSessionRef.current, true);
          }
          setProgress(event.progress || 0);
          // Python 那边现在发过来的是 "正在导入: IMG_001.JPG"，这里直接显示
          setStatusMsg(event.message);
          if (event.data && Number.isFinite(Number(event.data.totalBytes))) {
            setTransferStats({
              bytesCopied: Number(event.data.bytesCopied) || 0,
              totalBytes: Number(event.data.totalBytes) || 0,
              bytesPerSecond: Number(event.data.bytesPerSecond) || 0,
              filesCopied: Number.isFinite(Number(event.data.filesCopied)) ? Number(event.data.filesCopied) : undefined,
              totalFiles: Number.isFinite(Number(event.data.totalFiles)) ? Number(event.data.totalFiles) : undefined,
            });
          }
          break;

        case 'ask_user':
          if (event.data?.kind === 'project_routing') {
            if (event.data.stagingComplete) {
              stagingCompleteRef.current = true;
              if (currentImportSessionKeyRef.current && currentImportSessionRef.current) persistImportSession(currentImportSessionKeyRef.current, currentImportSessionRef.current, true);
            }
            const automaticRoutes = event.data.automaticRoutes || {};
            if (!event.data.requiresChoice) {
              continueRoutedImportRef.current(automaticRoutes);
            } else {
              setStatus('decision');
              setDecisionData({ ...event.data, routes: automaticRoutes });
              setStatusMsg(event.message);
            }
          } else if (event.data?.need_split) {
            setStatus('decision');
            setDecisionData(event.data);
            setStatusMsg(event.message);
          }
          break;

        case 'success':
          {
            const skipped = event.data?.skipped === true;
            const importedCount = Number(event.data?.importedCount);
            if (Number.isFinite(importedCount) && importedCount > 0) {
              window.electronAPI.trackTelemetry('photos_imported', {
                count_bucket: importCountBucket(importedCount),
                source: currentDriveTypeRef.current === 'broll' ? 'sd_broll' : 'sd_work',
                media_kind: 'mixed',
              });
            }
            const importedNames = Array.isArray(event.data?.projectNames) ? event.data.projectNames.map(String) : [];
            importedProjectNamesRef.current = Array.from(new Set([...importedProjectNamesRef.current, ...importedNames]));
            const completedDrive = currentDriveRef.current;
            if (completedDrive && currentImportSessionKeyRef.current) {
              driveImportSessionsRef.current.delete(currentImportSessionKeyRef.current);
              persistImportSession(currentImportSessionKeyRef.current, '');
            }
            if (skipped) {
              if (completedDrive && !skippedDrivesRef.current.includes(completedDrive)) skippedDrivesRef.current.push(completedDrive);
            } else {
              completedDriveCountRef.current += 1;
            }
            let nextDrive = importQueueRef.current.shift();
            while (nextDrive && !drivesRef.current.includes(nextDrive.path) && !hasPersistedImportSession(nextDrive.path, nextDrive.type)) {
              if (!failedDrivesRef.current.includes(nextDrive.path)) failedDrivesRef.current.push(nextDrive.path);
              nextDrive = importQueueRef.current.shift();
            }
            if (nextDrive) {
              setStatusMsg(skipped
                ? `${currentDriveRef.current} 没有符合条件的媒体，已跳过；接下来导入 ${nextDrive.path}`
                : `${currentDriveRef.current} 导入完成，接下来导入 ${nextDrive.path}`);
              setTimeout(() => startImportRef.current(nextDrive.path, nextDrive.type), 500);
            } else {
              const completedProjectNames = importedProjectNamesRef.current;
              isBusyRef.current = false; // 【解锁】
              currentDriveRef.current = '';
              currentStageRef.current = '';
              importRequestIdRef.current = '';
              currentImportSessionKeyRef.current = '';
              stagingCompleteRef.current = false;
              importedProjectNamesRef.current = [];
              setStatus('completed');
              setProgress(100);
              setStatusMsg(failedDrivesRef.current.length
                ? `批量导入已结束：${completedDriveCountRef.current} 张卡完成，${failedDrivesRef.current.join('、')} 未完成，可重新插卡后续传`
                : skippedDrivesRef.current.length
                  ? `${completedDriveCountRef.current ? `${completedDriveCountRef.current} 张卡导入完成；` : ''}${skippedDrivesRef.current.join('、')} 没有符合条件的媒体，已跳过`
                  : '导入完成');
              retryDrivePathsRef.current = failedDrivesRef.current.length ? [...failedDrivesRef.current] : [];
              setDecisionData(null);
              setCompletedProjectNames(completedProjectNames);
              setIsCancellingImport(false);
              onImportCompleteRef.current?.(completedProjectNames);
            }
          }
          break;

        case 'error':
          // 如果是普通的 warning 不打断流程
          if (event.message.includes("警告")) return;

          if (event.message.includes('旧暂存不会用于当前卡') || event.message.includes('检测到源文件已变化')) {
            if (currentImportSessionKeyRef.current) {
              driveImportSessionsRef.current.delete(currentImportSessionKeyRef.current);
              persistImportSession(currentImportSessionKeyRef.current, '');
            }
            currentImportSessionRef.current = '';
            currentImportSessionKeyRef.current = '';
          } else if (!directSource && currentDriveRef.current && (!drivesRef.current.includes(currentDriveRef.current) || event.message.includes('源设备可能已断开'))) {
            continueAfterDriveFailureRef.current(currentDriveRef.current, `设备 ${currentDriveRef.current} 读取失败`);
            break;
          }
          // 严重错误
          setStatusMsg("Error: " + event.message);
          setStatus('idle');
          importQueueRef.current = [];
          currentDriveRef.current = '';
          isBusyRef.current = false; // 【解锁】
          setIsCancellingImport(false);
          break;

        case 'cancelled':
          setStatusMsg('导入已取消');
          setStatus('idle');
          importQueueRef.current = [];
          currentDriveRef.current = '';
          isBusyRef.current = false;
          setIsCancellingImport(false);
          cancelRequestedRef.current = false;
          break;
      }
    });

    return cleanup;
  }, [active]);

  // 自动检查逻辑
  useEffect(() => {
    if (active && !directSource && config?.autoStart && !isBusyRef.current) {
      checkSD();
    }
  }, [active, config?.autoStart]);

  const checkSD = () => {
    if (isBusyRef.current) return;

    importRequestIdRef.current = crypto.randomUUID();
    setStatus('checking');
    setStatusMsg("正在扫描设备...");
    setLogs([]);

    const args = [];
    if (config) {
      args.push('--sd_path', selectedDrives[0] || config.sdPath);
    }
    runCmd('check', args);

    // 超时重置
    setTimeout(() => {
      setStatus((prevStatus) => {
        if (prevStatus === 'checking') {
          setStatusMsg("未检测到 SD 卡");
          return 'idle';
        }
        return prevStatus;
      });
    }, 30000);
  };

  const runActualImport = (routes: Record<string, string> = {}) => {
    const type = currentDriveTypeRef.current;
    const usesProjectRouting = workspaceProjects !== undefined;
    const resolvedDestinationPath = usesProjectRouting ? destinationPath : type === 'broll' ? brollDestinationPath : destinationPath;
    if (!resolvedDestinationPath) {
      setStatus('idle');
      setStatusMsg('无法确定导入目录。');
      isBusyRef.current = false;
      return;
    }
    setStatus('processing');
    setProgress(0);
    setDecisionData(null);
    const args = ['--sd_path', currentDriveRef.current || selectedDrives[0] || config?.sdPath || '', '--dest_path', resolvedDestinationPath];
    if (Object.keys(routes).length) args.push('--project_routes', JSON.stringify(routes));
    if (!usesProjectRouting) args.push('--direct_project');
    if (type === 'work' && config?.generateVideoPreview) args.push('--generate_video_preview', '--video_preview_quality', config.videoPreviewQuality);
    if (type === 'work' && config?.splitLargeFiles) args.push('--split_large_files');
    if (type === 'broll' && splitLargeBrollFiles) args.push('--split_large_files');
    runCmd(type === 'broll' ? 'broll' : 'import', args);
  };
  continueRoutedImportRef.current = runActualImport;

  const startImport = (sdPath = selectedDrives[0], type: 'work' | 'broll' = driveTypes[sdPath] || 'work') => {
    const usesProjectRouting = workspaceProjects !== undefined;
    const resolvedDestinationPath = usesProjectRouting ? destinationPath : type === 'broll' ? brollDestinationPath : destinationPath;
    if (!resolvedDestinationPath) {
      if (type === 'broll') {
        setStatusMsg('请先选择花絮要导入的目标项目。');
        return;
      }
      setStatusMsg('无法确定导入项目，请先设置工作目录。');
      return;
    }
    if (isBusyRef.current && !currentDriveRef.current) {
        console.log("Import already running, skipped.");
        return;
    }

    isBusyRef.current = true; // 【上锁】
    importRequestIdRef.current = crypto.randomUUID();
    const sessionKey = importSessionKeyFor(sdPath, type);
    const persistedSession = readPersistedImportSessions()[sessionKey];
    const resumableSession = driveImportSessionsRef.current.get(sessionKey) || persistedSession?.session || crypto.randomUUID();
    driveImportSessionsRef.current.set(sessionKey, resumableSession);
    persistImportSession(sessionKey, resumableSession);
    currentImportSessionKeyRef.current = sessionKey;
    currentImportSessionRef.current = resumableSession;
    currentDriveRef.current = sdPath;
    currentDriveTypeRef.current = type;
    stagingCompleteRef.current = persistedSession?.stagingComplete === true && !drivesRef.current.includes(sdPath);
    setStatus(usesProjectRouting ? 'processing' : 'importing');
    setProgress(0);
    setTransferStats(null);
    setLogs([]); // 清空日志准备开始
    setStatusMsg(type === 'broll' ? `正在把 ${sdPath} 导入“花絮”` : `正在整理 ${sdPath} 的工作文件`);

    if (usesProjectRouting) {
      setStatusMsg('正在导入素材…');
      runCmd('plan', ['--sd_path', sdPath, '--dest_path', resolvedDestinationPath, '--import_type', type, '--projects_json', JSON.stringify(workspaceProjects)]);
    } else {
      runActualImport();
    }
  };
  startImportRef.current = startImport;

  const startBatchImport = () => {
    if (isBusyRef.current) return;
    const requestedDrives = retryDrivePathsRef.current.length
      ? selectedDrives.filter(drive => retryDrivePathsRef.current.includes(drive))
      : selectedDrives;
    const connected = requestedDrives.filter(drive => drives.includes(drive) || hasPersistedImportSession(drive, driveTypes[drive] || 'work'));
    if (!connected.length) {
      setStatusMsg(retryDrivePathsRef.current.length ? `等待 ${retryDrivePathsRef.current.join('、')} 重新接入后续传` : '所选 SD 卡均未连接');
      return;
    }
    retryDrivePathsRef.current = [];
    const queue = directSource
      ? [{ path: connected[0], type: 'work' as const }]
      : connected.map(path => ({ path, type: driveTypes[path] || 'work' as const }));
    importQueueRef.current = queue.slice(1);
    importedProjectNamesRef.current = [];
    completedDriveCountRef.current = 0;
    failedDrivesRef.current = [];
    skippedDrivesRef.current = [];
    cancelRequestedRef.current = false;
    stagingCompleteRef.current = false;
    setIsCancellingImport(false);
    currentDriveRef.current = '';
    startImport(queue[0].path, queue[0].type);
  };
  startBatchRef.current = startBatchImport;

  const handleDecision = (split: boolean) => {
    setStatus('processing');
    setProgress(0);
    const args = [];
    if (config) {
      const resolvedDestinationPath = currentDriveTypeRef.current === 'broll' ? brollDestinationPath : destinationPath;
      if (!resolvedDestinationPath) {
        setStatus('idle');
        setStatusMsg(currentDriveTypeRef.current === 'broll' ? '请先选择花絮要导入的目标项目。' : '无法确定导入目录。');
        isBusyRef.current = false;
        return;
      }
      args.push('--sd_path', currentDriveRef.current || selectedDrives[0] || config.sdPath);
      args.push('--dest_path', resolvedDestinationPath);
      if (currentDriveTypeRef.current === 'work' && config.generateVideoPreview) {
        args.push('--generate_video_preview', '--video_preview_quality', config.videoPreviewQuality);
      }
      if ((currentDriveTypeRef.current === 'work' && config.splitLargeFiles) || (currentDriveTypeRef.current === 'broll' && splitLargeBrollFiles)) {
        args.push('--split_large_files');
      }
      // 添加用户决定的参数
      args.push('--should_split', split ? 'true' : 'false');
    }

    // 重新启动导入流程（因为临时文件已经存在，所以会很快）
    runCmd(currentDriveTypeRef.current === 'broll' ? 'broll' : 'import', args);
  };

  const confirmProjectRoutes = () => {
    const groups = Array.isArray(decisionData?.groups) ? decisionData.groups : [];
    const routes = decisionData?.routes || {};
    if (groups.some((group: any) => !routes[group.id])) {
      setStatusMsg('请为每个拍摄时间段选择项目。');
      return;
    }
    runActualImport(routes);
  };

  // --- 渲染逻辑 (UI 部分) ---

  if (status === 'idle' || status === 'checking') {
    // 实时判断当前配置的盘符是否插在电脑上
    const connectedDrives = selectedDrives.filter(drive => drives.includes(drive));
    const resumableDrives = selectedDrives.filter(drive => !drives.includes(drive) && hasPersistedImportSession(drive, driveTypes[drive] || 'work'));
    const isConnected = connectedDrives.length > 0;
    const canStartImport = isConnected || resumableDrives.length > 0;

    // 动态判断显示的副标题
    let displayMsg = statusMsg;
    if (status === 'idle') {
      if (statusMsg.startsWith('Error:') || statusMsg.includes('已断开')) {
        displayMsg = statusMsg;
      } else if (directSource) {
        displayMsg = selectedDrives.length
          ? `已选择 ${selectedDrives.length} 个来源，点击右侧按钮开始导入`
          : '请选择要导入的底片文件或文件夹';
      } else if (!selectedDrives.length) {
        displayMsg = "请选择 SD 卡盘符";
      } else if (isConnected) {
        displayMsg = `已连接 ${connectedDrives.length}/${selectedDrives.length} 张卡，点击右侧按钮批量导入`;
      } else if (resumableDrives.length) {
        displayMsg = `已找到 ${resumableDrives.length} 个本地暂存，可在 SD 卡断开时继续分类`;
      } else {
        displayMsg = `等待 ${selectedDrives.join('、')} 接入...`;
      }
    } else if (status === 'checking') {
      displayMsg = `正在准备读取 ${selectedDrives[0] || ''}...`;
    }

    // 动态图标颜色 (扫描中是蓝色，已连接是绿色，未连接是灰色)
    const iconColorClass = status === 'checking'
        ? 'bg-blue-50 text-blue-600'
        : isConnected
            ? 'bg-emerald-50 text-emerald-600'
            : 'bg-slate-100 text-slate-500';

    return (
      <div className="w-full space-y-3">
      <div className="w-full bg-white/50 border border-slate-200 rounded-xl p-4 flex items-center justify-between animate-in fade-in transition-all">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg transition-colors ${iconColorClass}`}>
            {status === 'checking' ? <Loader2 className="animate-spin" size={18} /> : <HardDrive size={18} />}
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold text-slate-800">{directSource ? '导入底片' : '从 SD 卡导入媒体'}</span>
            <span className="text-xs text-slate-500">{displayMsg}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!directSource && <details className="relative" onClick={event => event.stopPropagation()}>
            <summary className="flex h-9 min-w-36 cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:border-blue-400"><span className="max-w-40 truncate">{selectedDrives.length ? `已选 ${selectedDrives.length} 个盘符` : '选择盘符'}</span><ChevronDown size={15}/></summary>
            <div className="mt-1 min-w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
              {[...new Set([...selectedDrives, ...drives])].map(drive => <div key={drive} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-slate-50"><label className="flex min-w-0 cursor-pointer items-center gap-2"><input type="checkbox" checked={selectedDrives.includes(drive)} onChange={() => toggleDrive(drive)}/><span className="font-mono">{drive}</span></label><select aria-label={`${drive} 导入类型`} value={driveTypes[drive] || 'work'} onChange={event => setDriveType(drive, event.target.value as 'work' | 'broll')} className="ml-auto rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600" disabled={!selectedDrives.includes(drive)}><option value="work">工作文件</option><option value="broll">花絮</option></select><span className={`text-xs ${drives.includes(drive) ? 'text-emerald-600' : 'text-slate-400'}`}>{drives.includes(drive) ? '已连接' : '未连接'}</span></div>)}
              {!drives.length && !selectedDrives.length && <p className="px-2 py-1 text-xs text-slate-500">未检测到可用盘符</p>}
            </div>
          </details>}
          {canStartImport && status === 'idle' ? (
            <button onClick={startBatchImport} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold flex items-center gap-2 shadow-md shadow-blue-500/20 transition-all animate-in zoom-in-95"><Download size={16} />{directSource ? '开始导入' : connectedDrives.length > 1 ? '批量导入' : '开始导入'}</button>
          ) : (
            <button disabled className={`p-2 rounded-lg transition ${status === 'checking' ? 'text-blue-500' : 'text-slate-300 bg-slate-50 cursor-not-allowed'}`}><RotateCcw size={18} className={status === 'checking' ? 'animate-spin' : ''} /></button>
          )}
        </div>
      </div>
      {status === 'idle' && <>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <input type="checkbox" checked={shouldDeleteSourceAfterImport} onChange={event => setShouldDeleteSourceAfterImport(event.target.checked)} className="mt-0.5"/>
          <span><span className="block text-sm font-bold text-slate-700">导入后删除源文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">初始值来自设置。只有全部文件复制并校验成功后才会删除{directSource ? '所选底片' : '所选 SD 卡中的媒体'}；取消勾选则保留源文件。</span></span>
        </label>
      </>}
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      {/* 主卡片 */}
      <div className="bg-white/50 border border-slate-200 rounded-xl p-6 flex flex-col relative overflow-hidden min-h-[250px] animate-in slide-in-from-top-2">
        {/* 顶部标题栏 */}
        <div className="flex justify-between items-center mb-6 z-10">
          <h3 className="text-lg font-semibold text-blue-200 flex items-center gap-2">
            <FolderInput size={20} />
            {directSource ? '导入底片' : '从 SD 卡导入媒体'}
          </h3>
          <span className="text-xs px-2 py-1 rounded border font-mono bg-blue-500/20 text-blue-300 border-blue-500/30">
            {status.toUpperCase().replace('_', ' ')}
          </span>
        </div>

        {/* 背景装饰 */}
        <div className="absolute top-0 left-0 p-24 bg-blue-500/5 blur-3xl rounded-full pointer-events-none"></div>

        {/* 内容区域 */}
        <div className="flex-1 flex flex-col justify-center items-center text-center space-y-4 z-10 w-full">

          {/* State: Ready */}
          {status === 'completed' && (
            <div className="flex w-full max-w-xl flex-col items-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <CheckCircle2 size={34} />
              </div>
              <p className="text-lg font-bold text-slate-800">导入完成</p>
              <p className="mt-1 text-sm text-slate-500">
                {completedProjectNames.length
                  ? `素材已导入到 ${completedProjectNames.length} 个项目。`
                  : directSource ? '所选底片已成功导入。' : '所选 SD 卡素材已成功导入。'}
              </p>
              {transferStats && <p className="mt-2 text-xs font-medium tabular-nums text-slate-500">
                共导入 {formatTransferBytes(transferStats.totalBytes || transferStats.bytesCopied)}
                {transferStats.totalFiles ? ` · ${transferStats.totalFiles} 个文件` : ''}
              </p>}
              <button type="button" onClick={() => { if (onCompletedAction) onCompletedAction(); else resetCompletedImport(); }} className="dialog-primary mt-5">{completedActionLabel}</button>
            </div>
          )}

          {/* State: Ready */}
          {status === 'ready_to_import' && (
            <div className="flex flex-col items-center w-full">
              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4 text-blue-600">
                <Loader2 className="animate-spin" size={32} />
              </div>
              <p className="text-slate-800 font-bold text-lg mb-1">准备导入...</p>
              <p className="text-slate-500 text-sm mb-6">{statusMsg}</p>
            </div>
          )}

          {/* State: Progress (Importing or Processing) */}
          {(status === 'importing' || status === 'processing') && (
            <div className="w-full max-w-xl">
              <TaskProgress logs={logs} progress={progress} isRunning idleMessage={statusMsg} reportToTaskCenter={false} />
              {transferStats && <p className="mt-2 text-center text-xs font-medium tabular-nums text-slate-500">
                已导入 {formatTransferBytes(transferStats.bytesCopied)} / {formatTransferBytes(transferStats.totalBytes)}
                {transferStats.bytesPerSecond > 0 ? ` · ${formatTransferBytes(transferStats.bytesPerSecond)}/s` : ''}
                {transferStats.totalFiles ? ` · ${transferStats.filesCopied || 0}/${transferStats.totalFiles} 个文件` : ''}
              </p>}
              <button type="button" onClick={() => void cancelImport()} disabled={isCancellingImport} className="dialog-secondary mt-4 inline-flex items-center gap-2 disabled:opacity-50">{isCancellingImport && <Loader2 size={15} className="animate-spin"/>}{isCancellingImport ? '正在取消…' : '取消导入'}</button>
            </div>
          )}

          {/* State: Decision */}
          {status === 'decision' && decisionData && (
            <div className="w-full bg-slate-50/80 p-5 rounded-xl border border-yellow-500/20 text-left animate-in zoom-in-95">
              <h4 className="text-slate-800 font-bold mb-2 flex items-center gap-2">
                <AlertCircle className="text-yellow-400" size={20} />
                需确认操作
              </h4>
              {decisionData.kind === 'project_routing' ? <>
                <p className="mb-4 text-sm text-slate-500">没有唯一的精确日期项目，或同一天存在多个项目。系统已根据拍摄时间间隙识别出独立拍摄时段，请确认每一段的归属；多个时段可以选择同一个项目。</p>
                {decisionData.stagingComplete && currentDriveRef.current && !drives.includes(currentDriveRef.current) && <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">源设备已断开，但素材已完整导入到本地，可以继续分类；卡内源文件将无法在本次操作中自动删除。</p>}
                <div className="mb-5 max-h-72 space-y-3 overflow-y-auto pr-1">{decisionData.groups.map((group: any) => {
                  const suggested = new Set<string>(group.suggestedProjectPaths || []);
                  const orderedProjects = [...(workspaceProjects || [])].sort((left, right) => Number(suggested.has(right.path)) - Number(suggested.has(left.path)));
                  return <label key={group.id} className="block rounded-lg border border-slate-200 bg-white p-3"><span className="block text-sm font-bold text-slate-700">{group.date} · {group.startTime}–{group.endTime} · {group.count} 个文件</span><select value={decisionData.routes?.[group.id] || ''} onChange={event => setDecisionData((current: any) => ({ ...current, routes: { ...(current?.routes || {}), [group.id]: event.target.value } }))} className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"><option value="">请选择目标项目…</option>{orderedProjects.map(project => <option key={project.path} value={project.path}>{suggested.has(project.path) ? '建议 · ' : ''}{project.name} · {project.status}</option>)}</select></label>;
                })}</div>
                <button onClick={confirmProjectRoutes} className="w-full rounded-lg bg-blue-600 py-2 text-sm font-bold text-white hover:bg-blue-500">确认归属并开始导入</button>
              </> : <><p className="text-slate-500 text-sm mb-6">
                系统根据拍摄时间间隙识别出多个拍摄时段，是否需要拆分成不同文件夹？
              </p>
              <div className="flex gap-3">
                <button
                    onClick={() => handleDecision(true)}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-slate-800 py-2 rounded-lg text-sm transition-colors"
                >
                    是，拆分文件夹
                </button>
                <button
                    onClick={() => handleDecision(false)}
                    className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-900 py-2 rounded-lg text-sm transition-colors"
                >
                    否，合并在一起
                </button>
              </div></>}
              <button type="button" onClick={() => void cancelImport()} className="mt-3 w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-100">取消本次导入</button>
            </div>
          )}

        </div>
      </div>

    </div>
  );
};

const BirthdayManagerModal = ({ onClose, onDataChanged }: { onClose: () => void, onDataChanged: () => void }) => {
  const appDialog = useAppDialog();
  useEscapeLayer(true, onClose);
  const [birthdays, setBirthdays] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newMonth, setNewMonth] = useState('');
  const [newDay, setNewDay] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const load = async () => {
      if (window.electronAPI) {
        const data = await window.electronAPI.getBirthdays();
        setBirthdays(data || {});
        setLoading(false);
      }
    };
    load();
  }, []);

  const sortedBirthdays = Object.entries(birthdays).sort(([, dateA], [, dateB]) => {
    const parse = (d: string) => {
       const match = d.trim().match(/^(\d{1,2})(?:\.|月\.?)(\d{1,2})日?$/);
       return { m: Number(match?.[1] || 0), d: Number(match?.[2] || 0) };
    };
    const a = parse(dateA);
    const b = parse(dateB);
    if (a.m !== b.m) return a.m - b.m;
    return a.d - b.d;
  });

  const handleSave = async () => {
    const name = newName.trim();
    const month = Number(newMonth);
    const day = Number(newDay);
    if (!name) { setFormError('请输入姓名。'); return; }
    if (!Number.isInteger(month) || month < 1 || month > 12) { setFormError('月份必须是 1–12 的整数。'); return; }
    if (!Number.isInteger(day) || day < 1 || day > 31) { setFormError('日期必须是 1–31 的整数。'); return; }
    const probe = new Date(2000, month - 1, day);
    if (probe.getMonth() !== month - 1 || probe.getDate() !== day) { setFormError('该月份中不存在这个日期。'); return; }
    const dateStr = `${month}.${day}`;
    const newData = { ...birthdays, [name]: dateStr };

    if (window.electronAPI) {
      const result = await window.electronAPI.saveBirthdays(newData);
      if (!result.success) { setFormError(`保存失败：${result.error || '未知错误'}`); return; }
      setBirthdays(newData);
      setNewName('');
      setNewMonth('');
      setNewDay('');
      setFormError('');
      onDataChanged();
    }
  };

  const handleDelete = async (name: string) => {
    if (!await appDialog.confirm({
      title: `确定删除“${name}”吗？`,
      message: '该生日记录将被删除。',
      confirmLabel: '删除记录',
      tone: 'danger',
    })) return;
    const newData = { ...birthdays };
    delete newData[name];
    if (window.electronAPI) {
      await window.electronAPI.saveBirthdays(newData);
      setBirthdays(newData);
      onDataChanged();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0" onClick={onClose}></div>
      <div role="dialog" aria-modal="true" aria-label="生日列表" className="bg-white border border-slate-200 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[80vh] relative z-10">
        <div className="p-6 border-b border-slate-200 flex justify-between items-center bg-slate-200 rounded-t-2xl">
          <div><h3 className="text-xl font-bold text-slate-800">生日列表</h3></div>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-full text-slate-500 hover:text-slate-800 transition cursor-pointer"><X size={24} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-2">
          {loading ? <div className="text-center text-slate-500">Loading...</div> :
           sortedBirthdays.map(([name, date]) => (
            <div key={name} className="flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200 group">
               <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400"><User size={14} /></div>
                  <div><div className="font-medium text-slate-900">{name}</div><div className="text-xs text-slate-500">{date}</div></div>
               </div>
               <button onClick={() => handleDelete(name)} className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-red-400 transition"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <div className="p-6 border-t border-slate-200 bg-white rounded-b-2xl">
           <div className="flex gap-3">
              <input placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-slate-800" />
              <input aria-label="月份" placeholder="月" type="number" min="1" max="12" step="1" value={newMonth} onChange={e => { setNewMonth(e.target.value); setFormError(''); }} className="w-20 bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-center text-slate-800" />
              <input aria-label="日期" placeholder="日" type="number" min="1" max="31" step="1" value={newDay} onChange={e => { setNewDay(e.target.value); setFormError(''); }} className="w-20 bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-center text-slate-800" />
              <button onClick={handleSave} className="bg-blue-500 text-white px-4 py-2 rounded-lg flex items-center gap-2"><Plus size={16} /> 添加</button>
           </div>
           {formError && <p role="alert" className="mt-2 text-sm text-red-600">{formError}</p>}
        </div>
      </div>
    </div>
  );
};

type HomePanelDragProps = Pick<React.ComponentProps<'button'>, 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop'>;

const DashboardView = ({
  workspacePath,
  section = 'all',
  config,
  importDefaults,
  brollConfig,
  projectDestination,
  projectName,
  onImportConfigChange,
  onImportComplete,
  dragProps
}: {
  workspacePath: string;
  section?: 'all' | 'import' | 'birthday';
  config: AppConfig['smartImport'];
  importDefaults: AppConfig['importDefaults'];
  brollConfig: AppConfig['brollImport'];
  projectDestination?: string | null;
  projectName?: string;
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onImportComplete?: (projectNames: string[]) => void | Promise<void>;
  dragProps?: HomePanelDragProps;
}) => {
  // 生日逻辑保持不变
  const [upcomingBirthdays, setUpcomingBirthdays] = useState<{name: string, date: string, sortKey: number}[]>([]);
  const [loading, setLoading] = useState(true);
  const [showManager, setShowManager] = useState(false);
  const [drives, setDrives] = useState<string[]>([]);
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>([]);

  // 挂载时获取系统盘符
  useEffect(() => {
    const fetchDrives = async () => {
      if (window.electronAPI?.getDrives) {
        const sysDrives = await window.electronAPI.getDrives();
        // 只有当盘符发生变化时才更新状态，避免 React 无意义的频繁重绘
        setDrives(prevDrives => {
          if (JSON.stringify(prevDrives) === JSON.stringify(sysDrives)) {
            return prevDrives;
          }
          return sysDrives;
        });
      }
    };

    fetchDrives(); // 首次立刻执行获取

    // 每 3 秒钟在后台静默检查一次新插入的设备
    const intervalId = setInterval(fetchDrives, 3000);

    // 组件卸载时清理定时器
    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (projectDestination || !workspacePath) return;
    let mounted = true;
    const loadProjects = async () => {
      const result = await window.electronAPI.getWorkspaceProjects(workspacePath);
      if (!mounted || !result.success) return;
      const projects = result.statuses.flatMap(group => group.projects);
      setWorkspaceProjects(projects);
    };
    void loadProjects();
    const unsubscribe = window.electronAPI.onWorkspaceProjectsChanged(() => { void loadProjects(); });
    return () => { mounted = false; unsubscribe(); };
  }, [projectDestination, workspacePath]);

  // 解析 "M月.D日" 格式
  const parseBirthday = (dateStr: string) => {
    const match = dateStr.trim().match(/^(\d{1,2})(?:\.|月\.?)(\d{1,2})日?$/);
    return {
      month: Number(match?.[1] || 0),
      day: Number(match?.[2] || 0)
    };
  };

  const fetchBirthdays = async () => {
    if (!window.electronAPI) return;
    try {
      setLoading(true);
      const data = await window.electronAPI.getBirthdays();
      const today = new Date();
      const todayZero = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const currentMonth = today.getMonth() + 1;
      const nextMonth = (currentMonth % 12) + 1;
      const results: {name: string, date: string, sortKey: number}[] = [];

      Object.entries(data).forEach(([name, dateStr]) => {
        const { month, day } = parseBirthday(dateStr);
        const probe = new Date(2000, month - 1, day);
        if (month < 1 || month > 12 || day < 1 || day > 31 || probe.getMonth() !== month - 1 || probe.getDate() !== day) return;
        if (month === currentMonth || month === nextMonth) {
          let targetYear = today.getFullYear();
          if (currentMonth === 12 && month === 1) targetYear += 1;
          const birthdayDate = new Date(targetYear, month - 1, day);
          if (birthdayDate < todayZero) return;
          results.push({
            name,
            date: `${month}月${day}日`,
            sortKey: birthdayDate.getTime()
          });
        }
      });
      results.sort((a, b) => a.sortKey - b.sortKey);
      setUpcomingBirthdays(results);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBirthdays();
  }, []);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {projectDestination && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">当前项目：<strong>{projectName || projectDestination}</strong>{projectDestination.endsWith("花絮") ? " · 导入花絮" : " · 从 SD 卡导入"}</div>}
      {showManager && (
        <BirthdayManagerModal
          onClose={() => setShowManager(false)}
          onDataChanged={fetchBirthdays}
        />
      )}

      {section !== 'birthday' && <HomePanel title="从 SD 卡导入" initiallyOpen {...dragProps}>
        <div className="flex flex-col gap-6">
          <ImportCard config={config} drives={drives} destinationPath={projectDestination ?? workspacePath} brollDestinationPath={projectDestination} workspaceProjects={projectDestination ? undefined : workspaceProjects} deleteSourceAfterImport={importDefaults.deleteSourceAfterImport} generateJpgFromRaw={importDefaults.generateJpgFromRaw} splitLargeBrollFiles={brollConfig.splitLargeFiles} onImportConfigChange={onImportConfigChange} onImportComplete={projectDestination ? undefined : projectNames => { void onImportComplete?.(projectNames); }} completedActionLabel="刷新卡片" />
        </div>
      </HomePanel>}
      {section !== 'import' && <HomePanel title="角色生日" initiallyOpen tone="birthday" {...dragProps}>
        <div className="space-y-3">
          <div className="flex justify-between items-start">
              <h3 className="text-sm font-semibold text-slate-600 flex items-center gap-1.5">
                <span className="text-base">🎂</span> 角色生日
              </h3>
          </div>

          <div className="">
              {loading ? (
                <div className="text-indigo-400 text-sm">Loading birthdays...</div>
              ) : upcomingBirthdays.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pr-1">
                  {upcomingBirthdays.map((b, i) => (
                    // 内部小卡片改为白底，hover 时稍微加深
                    <div key={i} className="flex items-center justify-between bg-white/80 p-2.5 rounded-md border border-blue-100 hover:border-blue-200 transition group">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-[10px]">{b.name.charAt(0)}</div>
                        {/* 名字文字加深 */}
                        <span className="text-sm font-medium text-slate-700 pr-2 leading-snug">{b.name}</span>
                      </div>
                      <span className="flex-shrink-0 text-blue-600 font-mono text-[11px] bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">{b.date}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-40 text-indigo-400/60 text-sm italic">
                  <p>近期没有角色过生日哦。</p>
                </div>
              )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-3 border-t border-blue-100">
              <p className="text-[11px] text-slate-500">只显示接下来两个月的角色生日</p>
              {/* 管理按钮变亮 */}
              <button onClick={() => setShowManager(true)} className="flex items-center gap-1 px-2 py-1 rounded-md bg-white hover:bg-blue-50 text-blue-600 text-[11px] font-bold transition-all border border-blue-100">
                <Edit size={12} /> Manage
              </button>
          </div>
        </div>
      </HomePanel>}
    </div>
  );
};

const HomePanel = ({ title, initiallyOpen = false, tone, children, ...dragProps }: { title: string; initiallyOpen?: boolean; tone?: 'birthday'; children: React.ReactNode } & HomePanelDragProps) => {
  const [open, setOpen] = useState(initiallyOpen);
  const storageKey = `photoflow:home-panel:${title}`;
  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved !== null) setOpen(saved === 'true');
  }, [storageKey]);
  useEffect(() => {
    window.localStorage.setItem(storageKey, String(open));
  }, [open, storageKey]);
  const isBirthday = tone === 'birthday';
  return <section className={`rounded-xl overflow-hidden ${isBirthday ? 'birthday-panel' : 'border border-slate-200 bg-white'}`}>
    <button {...dragProps} onClick={() => setOpen(value => !value)} aria-expanded={open} className={`flex w-full items-center justify-between px-5 py-4 text-left ${dragProps.draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${isBirthday ? 'birthday-panel-header' : ''}`}>
      <span className={`text-base font-bold ${isBirthday ? 'birthday-panel-title' : 'text-slate-800'}`}>{title}</span>
      <span className={isBirthday ? 'birthday-panel-icon' : 'text-slate-400'}>{open ? <ChevronUp size={18}/> : <ChevronDown size={18}/>}</span>
    </button>
    <div hidden={!open} className={`border-t p-5 ${open ? 'animate-in slide-in-from-top-1 duration-200' : ''} ${isBirthday ? 'birthday-panel-body' : 'border-slate-100'}`}>
      {children}
    </div>
  </section>;
};

const ConverterView = ({ embedded = false, initialTargetPath = "", initialTargetPaths }: { embedded?: boolean; initialTargetPath?: string; initialTargetPaths?: string[] }) => {
  const [targetPaths, setTargetPaths] = useState<string[]>(() => initialTargetPaths?.filter(Boolean) || (initialTargetPath ? [initialTargetPath] : []));
  const [quality, setQuality] = useState(100);
  const { logs, isRunning, progress, start } = usePythonTask('png_to_jpg.py', '进度');

  useEffect(() => {
    setTargetPaths(initialTargetPaths?.filter(Boolean) || (initialTargetPath ? [initialTargetPath] : []));
  }, [initialTargetPath, initialTargetPaths]);

  const startConversion = () => {
    if (!targetPaths.length) return;
    start(['--quality', quality.toString(), ...targetPaths], '正在转换…');
  };

  return (
    <div className="w-full space-y-6">
      {!embedded && <h2 className="text-2xl font-bold text-slate-800">PNG 转 JPG </h2>}
      <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>

        {/* Path Input with Drag & Drop */}
        <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-500 uppercase">目标文件或文件夹{targetPaths.length > 1 ? `（${targetPaths.length} 项）` : ''}</label>
            <div className="relative">
                <div className="absolute left-3 top-3 text-slate-500">
                    <FolderInput size={18} />
                </div>
                <textarea
                  value={targetPaths.join('\n')}
                  readOnly
                  rows={Math.min(5, Math.max(1, targetPaths.length))}
                  aria-label="要转换的文件或文件夹"
                  className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 py-3 pl-10 pr-4 font-mono text-sm text-slate-700"
                />
            </div>
            <p className="text-xs text-slate-600 flex items-center gap-1">
               <AlertCircle size={12}/>
               所选 PNG 文件及文件夹当前层级内的 PNG 会转为 JPG，原始 PNG 会移入回收站
            </p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg bg-slate-50 p-3 border border-slate-200">
          <label className="text-sm font-medium text-slate-700">导出JPG 画质</label>
          <select value={quality} onChange={event => setQuality(Number(event.target.value))} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-blue-500">
            <option value={100}>最高（100）</option>
            <option value={95}>高（95）</option>
            <option value={85}>标准（85）</option>
            <option value={75}>节省空间（75）</option>
          </select>
        </div>
        {/* Progress & Actions */}
        <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          idleMessage={isRunning ? '正在转换…' : '进度'}
          action={<button
                onClick={startConversion}
                disabled={!targetPaths.length || isRunning}
                className={`px-8 py-2 rounded-lg font-bold transition flex items-center gap-2 ${
                  isRunning || !targetPaths.length
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200 shadow-none'
                    : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20'
                }`}
             >
                {isRunning ? <Loader2 className="animate-spin" size={18} /> : <Play size={18} fill="currentColor" />}
                {isRunning ? '转换中...' : '开始转换'}
             </button>}
        />
      </div>

    </div>
  );
};

type ScreenshotMainImageSummary = Awaited<ReturnType<typeof window.electronAPI.extractScreenshotMainImages>> & {
  recycledOriginalCount?: number;
  permanentOriginalCount?: number;
  recycleError?: string;
};

type ScreenshotCropReviewItem = {
  relativePath: string;
  input: string;
  inputName: string;
  crop: CropRectangle;
  snapGuides: { x: number[]; y: number[] };
  originalSize: { width: number; height: number };
  confidence: number;
  reason?: string;
  needsReview: boolean;
  confirmed: boolean;
  included: boolean;
};

const ScreenshotCropPreview = ({ item, cacheConfig, queueOrder, onEdit }: { item: ScreenshotCropReviewItem; cacheConfig: AppConfig['mediaCache']; queueOrder: number; onEdit: (previewUrl: string) => void }) => {
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    let active = true;
    let fallbackTimer: number | undefined;
    setPreviewUrl(''); setPreviewError('');
    const loadOriginal = () => window.electronAPI.getMediaOriginal(item.input, 'image', cacheConfig).then(result => {
      if (!active) return;
      if (result.mediaUrl) { setPreviewUrl(result.mediaUrl); setPreviewError(''); }
      else setPreviewError(result.error || '预览加载失败');
    }).catch(error => { if (active) setPreviewError(error instanceof Error ? error.message : String(error)); });
    const stopUpdates = window.electronAPI.onThumbnailStateChanged(update => {
      if (update.filePath.toLocaleLowerCase() !== item.input.toLocaleLowerCase()) return;
      if (update.state === 'READY') {
        const url = update.previewUrls?.large || update.previewUrls?.medium || update.previewUrls?.small;
        if (url && active) { setPreviewUrl(url); setPreviewError(''); }
      } else if (update.state === 'FAILED' || update.state === 'MISSING') {
        void loadOriginal();
      }
    });
    window.electronAPI.getMediaThumbnail(item.input, 'image', cacheConfig, 900, item.needsReview ? 0 : 1, queueOrder).then(result => {
      if (!active) return;
      if (result.previewUrl) { setPreviewUrl(result.previewUrl); return; }
      if (result.state === 'QUEUED' || result.state === 'GENERATING') fallbackTimer = window.setTimeout(() => { void loadOriginal(); }, 8000);
      else void loadOriginal();
    }).catch(() => { void loadOriginal(); });
    return () => { active = false; stopUpdates(); if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer); };
  }, [cacheConfig, item.input, item.needsReview, queueOrder]);
  return <div className="relative flex h-44 items-center justify-center overflow-hidden rounded-lg bg-slate-950">
    {previewUrl ? <svg className="h-full w-full" viewBox={`0 0 ${item.originalSize.width} ${item.originalSize.height}`} preserveAspectRatio="xMidYMid meet"><image href={previewUrl} width={item.originalSize.width} height={item.originalSize.height}/><path d={`M0 0H${item.originalSize.width}V${item.originalSize.height}H0Z M${item.crop.x} ${item.crop.y}V${item.crop.y + item.crop.height}H${item.crop.x + item.crop.width}V${item.crop.y}Z`} fill="rgba(2,6,23,.58)" fillRule="evenodd"/><rect x={item.crop.x} y={item.crop.y} width={item.crop.width} height={item.crop.height} fill="none" stroke={item.confirmed ? '#34d399' : '#f59e0b'} strokeWidth={Math.max(4, item.originalSize.width / 260)}/></svg> : <p className="px-4 text-center text-xs text-slate-400">{previewError || '正在加载预览…'}</p>}
    <button type="button" disabled={!previewUrl || !item.included} onClick={() => onEdit(previewUrl)} className="absolute bottom-2 right-2 rounded-md bg-slate-950/80 px-2.5 py-1.5 text-xs font-bold text-white shadow disabled:opacity-40">调整范围</button>
  </div>;
};

const ScreenshotMainImageView = ({
  embedded = false,
  workspacePath,
  projectStatus,
  projectName,
  initialRelativePaths,
  cacheConfig,
  onFilesChanged,
}: {
  embedded?: boolean;
  workspacePath: string;
  projectStatus: ProjectStatus;
  projectName: string;
  initialRelativePaths: string[];
  cacheConfig: AppConfig['mediaCache'];
  onFilesChanged?: () => void | Promise<void>;
}) => {
  const appDialog = useAppDialog();
  const [targetPaths, setTargetPaths] = useState(() => initialRelativePaths.filter(Boolean));
  const [isRunning, setIsRunning] = useState(false);
  const [preserveOriginal, setPreserveOriginal] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('进度');
  const [summary, setSummary] = useState<ScreenshotMainImageSummary | null>(null);
  const [reviewItems, setReviewItems] = useState<ScreenshotCropReviewItem[]>([]);
  const [analysisErrors, setAnalysisErrors] = useState<Array<{ inputName: string; error?: string }>>([]);
  const [cropEditor, setCropEditor] = useState<{ index: number; previewUrl: string; crop: CropRectangle; snapEnabled: boolean } | null>(null);
  const requestIdRef = React.useRef('');
  const preserveOriginalRef = React.useRef(false);
  const issueResults = useMemo(() => (summary?.results || []).filter(result => !result.cropped), [summary]);
  const firstTargetName = targetPaths[0]?.split(/[\\/]/).pop() || '';
  const pendingReviewCount = reviewItems.filter(item => item.included && !item.confirmed).length;
  const includedReviewItems = reviewItems.filter(item => item.included);
  const progressLogs = useMemo<LogEntry[]>(() => summary ? [{
    timestamp: new Date().toLocaleTimeString(),
    message: summary.recycleError
      ? `主图已生成，但原图未能移入回收站：${summary.recycleError}`
      : summary.success
        ? `处理完成：已生成 ${summary.croppedCount || 0} 张主图${summary.skippedCount ? `，跳过 ${summary.skippedCount} 张` : ''}${summary.failedCount ? `，失败 ${summary.failedCount} 张` : ''}${summary.recycledOriginalCount !== undefined ? `；${summary.recycledOriginalCount} 张原图已移入回收站` : ''}`
        : summary.error || '提取失败',
    type: summary.recycleError || !summary.success ? 'error' : 'success',
  }] : reviewItems.length ? [{ timestamp: new Date().toLocaleTimeString(), message: statusMessage, type: pendingReviewCount ? 'warning' : 'success' }] : [], [pendingReviewCount, reviewItems.length, statusMessage, summary]);

  useEffect(() => {
    setTargetPaths(initialRelativePaths.filter(Boolean));
    setSummary(null);
    setReviewItems([]);
    setAnalysisErrors([]);
    setCropEditor(null);
    setProgress(0);
    setStatusMessage('进度');
  }, [initialRelativePaths]);

  useEffect(() => window.electronAPI.onScreenshotMainImageProgress(value => {
    if (!requestIdRef.current || value.requestId !== requestIdRef.current) return;
    const extractionProgress = Math.max(0, Math.min(100, Number(value.progress) || 0));
    setProgress(preserveOriginalRef.current ? extractionProgress : extractionProgress * .9);
    if (value.message) setStatusMessage(value.message);
  }), []);

  const startAnalysis = async () => {
    if (!targetPaths.length || isRunning) return;
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    requestIdRef.current = requestId;
    preserveOriginalRef.current = true;
    setIsRunning(true);
    setSummary(null);
    setProgress(0);
    setReviewItems([]);
    setAnalysisErrors([]);
    setStatusMessage('正在分析截图主图…');
    try {
      const analysis = await window.electronAPI.extractScreenshotMainImages(workspacePath, projectStatus, projectName, targetPaths, { requestId, analyzeOnly: true });
      const nextItems = analysis.results.flatMap((result, index) => result.success && result.crop && result.originalSize ? [{
        relativePath: targetPaths[index], input: result.input, inputName: result.inputName, crop: result.crop, snapGuides: result.snapGuides || { x: [0, result.originalSize.width], y: [0, result.originalSize.height] },
        originalSize: result.originalSize, confidence: Number(result.confidence || 0), reason: result.reason,
        needsReview: Boolean(result.needsReview), confirmed: !result.needsReview, included: true,
      }] : []);
      setReviewItems(nextItems);
      setAnalysisErrors(analysis.results.filter(result => !result.success).map(result => ({ inputName: result.inputName, error: result.error })));
      setProgress(100);
      setStatusMessage(nextItems.some(item => !item.confirmed) ? '请确认需要检查的裁剪范围' : '范围分析完成，可以生成主图');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSummary({ success: false, results: [], error: message });
      setStatusMessage(message);
    } finally {
      requestIdRef.current = '';
      setIsRunning(false);
    }
  };

  const confirmExtraction = async () => {
    if (!includedReviewItems.length || pendingReviewCount || isRunning) return;
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    requestIdRef.current = requestId;
    preserveOriginalRef.current = preserveOriginal;
    setIsRunning(true);
    setSummary(null);
    setProgress(0);
    setStatusMessage('正在按确认范围生成主图…');
    const confirmedPaths = includedReviewItems.map(item => item.relativePath);
    try {
      const extraction = await window.electronAPI.extractScreenshotMainImages(workspacePath, projectStatus, projectName, confirmedPaths, { requestId, crops: includedReviewItems.map(item => item.crop) });
      let nextSummary: ScreenshotMainImageSummary = extraction;
      const croppedRelativePaths = confirmedPaths.filter((_relativePath, index) => extraction.results[index]?.success && extraction.results[index]?.cropped);
      if (!preserveOriginal && croppedRelativePaths.length) {
        setProgress(90);
        setStatusMessage(`正在将 ${croppedRelativePaths.length} 张原图移入回收站…`);
        const recycled = await window.electronAPI.projectFileOperation(workspacePath, projectStatus, projectName, 'trash', croppedRelativePaths);
        if (recycled.success) {
          nextSummary = { ...extraction, recycledOriginalCount: recycled.count || 0, permanentOriginalCount: recycled.permanentCount || 0 };
        } else {
          const recycleError = recycled.error || '原图未能移入回收站';
          nextSummary = { ...extraction, success: false, recycleError, error: recycleError };
          if (isRecycleBinFailure(recycled.error, recycled.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
        }
      }
      if (croppedRelativePaths.length) await onFilesChanged?.();
      setSummary(nextSummary);
      setReviewItems([]);
      setProgress(nextSummary.recycleError ? 90 : 100);
      setStatusMessage(nextSummary.recycleError ? '主图已生成，但回收原图失败' : nextSummary.success ? '处理完成' : nextSummary.error || '提取失败');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSummary({ success: false, results: [], error: message });
      setStatusMessage(message);
    } finally {
      requestIdRef.current = '';
      setIsRunning(false);
    }
  };

  const updateReviewItem = (index: number, changes: Partial<ScreenshotCropReviewItem>) => setReviewItems(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item));
  const saveEditedCrop = () => {
    if (!cropEditor) return;
    const item = reviewItems[cropEditor.index];
    if (!item) return;
    const x = Math.max(0, Math.min(item.originalSize.width - 20, Math.round(cropEditor.crop.x)));
    const y = Math.max(0, Math.min(item.originalSize.height - 20, Math.round(cropEditor.crop.y)));
    const width = Math.max(20, Math.min(item.originalSize.width - x, Math.round(cropEditor.crop.width)));
    const height = Math.max(20, Math.min(item.originalSize.height - y, Math.round(cropEditor.crop.height)));
    updateReviewItem(cropEditor.index, { crop: { x, y, width, height }, confirmed: true });
    setCropEditor(null);
  };

  return <div className="w-full space-y-6">
    {!embedded && <h2 className="text-2xl font-bold text-slate-800">提取截图主图</h2>}
    <div className={embedded ? 'space-y-5' : 'space-y-5 rounded-xl border border-slate-200 bg-white p-6'}>
      <div className="space-y-2">
        <p className="text-sm leading-6 text-slate-600">先生成主图候选框，再处理确认后的范围。低置信结果会重点提示并允许拖动调整，确认前不会生成文件或处理原图。</p>
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-blue-600 shadow-sm"><Crop size={18}/></span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800">已选择 {targetPaths.length} 张截图</p>
            <p className="mt-0.5 truncate text-xs text-slate-500" title={targetPaths.length === 1 ? firstTargetName : undefined}>{targetPaths.length === 1 ? firstTargetName : '将按同一版式批量识别主图区域'}</p>
          </div>
        </div>
        <p className="flex items-center gap-1 text-xs text-slate-500"><AlertCircle size={12}/>主图保存在原图旁；黄色项目需要确认，绿色项目可直接批量生成。</p>
        <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <input type="checkbox" checked={preserveOriginal} disabled={isRunning} onChange={event => setPreserveOriginal(event.currentTarget.checked)} className="mt-0.5 h-4 w-4 accent-blue-600"/>
          <span><span className="font-bold">保留原图</span><span className="mt-1 block text-xs leading-5 text-slate-500">默认关闭；关闭时仅把成功裁剪的原图移入系统回收站，跳过或失败的图片保持不变。</span></span>
        </label>
      </div>

      {!!reviewItems.length && <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold text-slate-800">检查裁剪范围</h3><p className="mt-0.5 text-xs text-slate-500">{pendingReviewCount ? `还有 ${pendingReviewCount} 张需要确认` : `已确认 ${includedReviewItems.length} 张，可以生成主图`}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${pendingReviewCount ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{pendingReviewCount ? '待检查' : '已就绪'}</span></div><div className="grid gap-3 md:grid-cols-2">{reviewItems.map((item, index) => <article key={item.relativePath} className={`rounded-xl border p-3 ${!item.included ? 'border-slate-200 bg-slate-50 opacity-65' : item.confirmed ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-300 bg-amber-50/60'}`}><div className="mb-2 flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-xs font-bold text-slate-800" title={item.inputName}>{item.inputName}</p><p className="mt-0.5 text-[11px] text-slate-500">置信度 {Math.round(item.confidence * 100)}% · {item.crop.width} × {item.crop.height}</p></div><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${item.confirmed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{item.confirmed ? '已确认' : '需检查'}</span></div><ScreenshotCropPreview item={item} cacheConfig={cacheConfig} queueOrder={index} onEdit={previewUrl => setCropEditor({ index, previewUrl, crop: { ...item.crop }, snapEnabled: true })}/>{item.reason && <p className="mt-2 text-[11px] leading-4 text-amber-700">{item.reason}</p>}<div className="mt-3 flex justify-between gap-2"><button type="button" onClick={() => updateReviewItem(index, { included: !item.included, confirmed: item.included ? item.confirmed : true })} className="dialog-secondary px-3 py-1.5 text-xs">{item.included ? '不处理这张' : '恢复处理'}</button>{item.included && !item.confirmed && <button type="button" onClick={() => updateReviewItem(index, { confirmed: true })} className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-400">范围正确</button>}</div></article>)}</div></section>}

      {!!analysisErrors.length && <details className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"><summary className="cursor-pointer font-semibold">{analysisErrors.length} 张图片无法读取</summary><div className="mt-2 space-y-1">{analysisErrors.map((item, index) => <p key={`${item.inputName}-${index}`}>{item.inputName}：{item.error || '分析失败'}</p>)}</div></details>}

      <TaskProgress
        logs={progressLogs}
        progress={progress}
        isRunning={isRunning}
        idleMessage={statusMessage}
        action={<button type="button" onClick={() => void (reviewItems.length ? confirmExtraction() : startAnalysis())} disabled={!targetPaths.length || isRunning || Boolean(reviewItems.length && (!includedReviewItems.length || pendingReviewCount))} className={`flex items-center gap-2 rounded-lg px-8 py-2.5 font-bold transition ${!targetPaths.length || isRunning || Boolean(reviewItems.length && (!includedReviewItems.length || pendingReviewCount)) ? 'cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400 shadow-none' : 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 hover:bg-blue-500'}`}>
          {isRunning ? <Loader2 size={18} className="animate-spin"/> : <Crop size={18}/>}
          {isRunning ? '正在处理…' : reviewItems.length ? pendingReviewCount ? `先确认 ${pendingReviewCount} 张` : `生成 ${includedReviewItems.length} 张主图` : summary ? '重新分析' : `分析范围${targetPaths.length > 1 ? `（${targetPaths.length} 张）` : ''}`}
        </button>}
      />
      {!!issueResults.length && <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><summary className="cursor-pointer font-semibold">查看 {issueResults.length} 个异常项目</summary><div className="mt-2 max-h-36 space-y-1.5 overflow-y-auto">{issueResults.map((result, index) => <p key={`${result.input}-${index}`} className="break-words"><span className="font-semibold">{result.inputName}</span>：{result.skipped ? result.reason || '已跳过' : result.error || '处理失败'}</p>)}</div></details>}
    </div>
    {cropEditor && (() => { const item = reviewItems[cropEditor.index]; if (!item) return null; return <div role="dialog" aria-modal="true" className="fixed inset-0 z-[470] flex items-center justify-center bg-slate-950/75 p-3"><div className="flex max-h-[96vh] w-full max-w-6xl flex-col overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"><div className="flex items-start gap-3"><div><h3 className="font-bold text-slate-900">调整主图范围</h3><p className="mt-1 text-xs text-slate-500">拖动框体移动，拖动四角调整大小；靠近检测边缘时会自动吸附。</p></div><label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700"><input type="checkbox" checked={cropEditor.snapEnabled} onChange={event => setCropEditor(current => current ? { ...current, snapEnabled: event.currentTarget.checked } : current)} className="accent-blue-600"/>磁吸边缘</label><button type="button" onClick={() => setCropEditor(null)} className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={18}/></button></div><InteractiveCropEditor large snapEnabled={cropEditor.snapEnabled} snapGuides={item.snapGuides} previewUrl={cropEditor.previewUrl} imageSize={item.originalSize} crop={cropEditor.crop} onChange={crop => setCropEditor(current => current ? { ...current, crop } : current)}/><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key} className="text-xs font-bold text-slate-600">{{ x: '左边 X', y: '顶部 Y', width: '宽度', height: '高度' }[key]}<input type="number" min={key === 'x' || key === 'y' ? 0 : 20} value={cropEditor.crop[key]} onChange={event => setCropEditor(current => current ? { ...current, crop: { ...current.crop, [key]: Math.max(key === 'x' || key === 'y' ? 0 : 20, Math.round(Number(event.target.value) || 0)) } } : current)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2"/></label>)}</div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setCropEditor(null)} className="dialog-secondary">取消</button><button type="button" onClick={saveEditedCrop} className="dialog-primary">确认范围</button></div></div></div>; })()}
  </div>;
};

const ResearchView = ({
  embedded = false,
  config,
  onUpdateConfig,
  initialTargetPath = '',
  targetKind = 'file',
  hasTxtFiles = false,
}: {
  embedded?: boolean;
  config: AppConfig['research'];
  onUpdateConfig: (newConfig: AppConfig['research']) => void;
  initialTargetPath?: string;
  targetKind?: 'file' | 'folder';
  hasTxtFiles?: boolean;
}) => {
  const { logs, isRunning, progress, statusMsg, start } = usePythonTask('research.py', '准备就绪');
  const [targetPath, setTargetPath] = useState(initialTargetPath);
  const [organizeData, setOrganizeData] = useState(true);

  useEffect(() => {
    setTargetPath(initialTargetPath);
    setOrganizeData(true);
  }, [initialTargetPath]);

  const runAnalysis = () => {
    const args = [
      '--path', targetPath,
      '--sensitivity', config.sensitivity,
      '--min_duration', config.minDuration.toString()
    ];
    if (targetKind === 'folder' && hasTxtFiles && organizeData) args.push('--organize-data');
    start(args, '正在初始化引擎...');
  };

  return (
    <div className="w-full space-y-6">
      {!embedded && <h2 className="text-2xl font-bold text-slate-800">提取分镜帧</h2>}
      <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>
        <div className="space-y-2">
          <p className="mt-2 text-gray-600">对视频的分镜执行转场识别，并从每个分镜中挑选清晰的画面导出。</p>
        </div>
        {/* 路径设置 */}
        <div className="space-y-2">
           <label className="text-xs font-semibold text-slate-500 uppercase">读取目录或视频</label>
           <input
             type="text"
             value={targetPath}
             readOnly
             aria-label={targetKind === 'folder' ? '要处理的文件夹' : '要处理的视频'}
             className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-slate-700 font-mono text-sm outline-none"
           />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="form-label">检测灵敏度</label>
            <select value={config.sensitivity} onChange={event => onUpdateConfig({ ...config, sensitivity: event.target.value as AppConfig['research']['sensitivity'] })} className="form-input"><option value="low">低</option><option value="standard">标准</option><option value="high">高</option></select>
            <p className="mt-1 text-xs leading-5 text-slate-500">{{ low: '只保留明显硬切，截图最少。', standard: '兼顾硬切、渐变与误判率。', high: '识别更多轻微转场，截图更多。' }[config.sensitivity]}</p>
          </div>
          <div>
            <label className="form-label">最小片段时长（秒）</label>
            <input type="number" min="0.05" max="5" step="0.05" value={config.minDuration} onChange={event => onUpdateConfig({ ...config, minDuration: Math.min(5, Math.max(0.05, Number(event.target.value) || 0.05)) })} className="form-input"/>
            <p className="mt-1 text-xs leading-5 text-slate-500">数值越大，短暂画面会被过滤，最终导出的截图越少。</p>
          </div>
        </div>
        {targetKind === 'folder' && hasTxtFiles && <label className="settings-check"><input type="checkbox" checked={organizeData} onChange={event => setOrganizeData(event.target.checked)}/><span><span className="block">整理 data 文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">处理完成后，将当前目录中的 TXT 文件移入 data 文件夹。</span></span></label>}

        <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          idleMessage={statusMsg}
          action={<button
               onClick={runAnalysis}
               disabled={isRunning || !targetPath.trim()}
               className={`px-6 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${
                 isRunning
                  ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none'
                  : 'bg-blue-600 text-white hover:bg-blue-500 shadow-md shadow-blue-500/20'
               }`}
             >
                {isRunning ? <Loader2 className="animate-spin" size={18}/> : <Play size={18} fill="currentColor" />}
                {isRunning ? '处理中' : '开始处理'}
             </button>}
        />
      </div>
    </div>
  );
};

const MatchView = ({
        embedded = false,
        config,
        projectPath,
        onUpdateConfig,
        folderOptions = []
    }: {
        embedded?: boolean;
        config: AppConfig['smartMatch'];
        projectPath?: string;
        onUpdateConfig: (newMatchConfig: AppConfig['smartMatch']) => void;
        folderOptions?: Array<{ name: string; path: string }>;
    }) => {
    const [keywords, setKeywords] = useState("");
    const [isConfirming, setIsConfirming] = useState(false);
    const appDialog = useAppDialog();
    const baseArgsRef = React.useRef<string[]>([]);
    const { logs, isRunning, isCancelling, progress, statusMsg, preview, clearPreview, start, cancel } = usePythonTask('catch.py', '进度');

    useEffect(() => {
        if (!preview) return;
        clearPreview();
        setIsConfirming(true);
        const showPreview = async () => {
            const filesToCopy = Number(preview.filesToCopy || 0);
            const existingCount = Number(preview.existingCount || 0);
            const conflictCount = Number(preview.conflictCount || 0);
            const missingKeywords = Array.isArray(preview.missingKeywords) ? preview.missingKeywords : [];
            const details = [
                `图片 ${Number(preview.imageCount || 0)} 个，视频 ${Number(preview.videoCount || 0)} 个`,
                existingCount ? `目标中已存在 ${existingCount} 个，将保留原文件` : '',
                conflictCount ? `发现 ${conflictCount} 个来源同名冲突，将跳过以避免覆盖` : '',
                missingKeywords.length ? `未找到 ${missingKeywords.length} 个编号：${missingKeywords.slice(0, 10).join('、')}${missingKeywords.length > 10 ? '…' : ''}` : '',
            ].filter(Boolean).join('；');

            if (filesToCopy === 0) {
                await appDialog.alert({
                    title: '没有需要复制的新文件',
                    message: existingCount || conflictCount ? '匹配项均已存在或存在同名冲突。' : '没有找到与这些编号完全匹配的媒体文件。',
                    detail: details || undefined,
                });
                return;
            }

            const confirmed = await appDialog.confirm({
                title: '确认从文件名选片',
                message: `将复制 ${filesToCopy} 个文件，共 ${formatTransferBytes(Number(preview.totalBytes || 0))}。`,
                detail: details || undefined,
                confirmLabel: '开始复制',
                cancelLabel: '取消',
            });
            if (confirmed) {
                start([...baseArgsRef.current, '--execute', '--expected_signature', String(preview.signature || '')], '正在复制…');
            }
        };
        void showPreview().finally(() => setIsConfirming(false));
    }, [appDialog, clearPreview, preview, start]);

    const runTask = () => {
        if (!projectPath || !keywords.trim() || isRunning || isConfirming) return;
        baseArgsRef.current = [
            '--source', projectPath,
            '--image_dest_name', IMAGE_SELECTION_FOLDER_NAME,
            '--video_dest_name', VIDEO_SELECTION_FOLDER_NAME,
            '--image_source_name', config.imageSourceFolderName || '',
            '--video_source_name', config.videoSourceFolderName || '',
            '--keywords', ...keywords.trim().split(/\s+/)
        ];
        start(baseArgsRef.current, '正在预检…');
    };

    return (
        <div className="w-full space-y-6">
            {!embedded && <h2 className="text-2xl font-bold text-slate-800">选片</h2>}
            <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="text-sm text-slate-600">从文件夹选择图片<select value={config.imageSourceFolderName ?? 'raw'} onChange={event => onUpdateConfig({ ...config, imageSourceFolderName: event.target.value || undefined })} className="form-input mt-1"><option value="">无</option>{folderOptions.map(folder => <option key={folder.path} value={folder.name}>{folder.name}</option>)}</select><span className="mt-1 block text-xs font-bold text-slate-500">选中的图片会存放到“{IMAGE_SELECTION_FOLDER_NAME}”文件夹</span></label><label className="text-sm text-slate-600">从文件夹选择视频<select value={config.videoSourceFolderName ?? 'mov'} onChange={event => onUpdateConfig({ ...config, videoSourceFolderName: event.target.value || undefined })} className="form-input mt-1"><option value="">无</option>{folderOptions.map(folder => <option key={folder.path} value={folder.name}>{folder.name}</option>)}</select><span className="mt-1 block text-xs font-bold text-slate-500">选中的视频会存放到“{VIDEO_SELECTION_FOLDER_NAME}”文件夹</span></label></div>
                <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 uppercase">文件名</label>
                    <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="文件名需要用空格分开，一个空格分开一个文件名" className="h-24 min-h-24 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm text-slate-900 transition-colors focus:border-blue-500 focus:outline-none"/>
                </div>
                <TaskProgress
                    logs={logs}
                    progress={progress}
                    isRunning={isRunning}
                    idleMessage={statusMsg}
                    action={<button onClick={isRunning ? () => void cancel() : runTask} disabled={isCancelling || isConfirming || (!isRunning && (!projectPath || !keywords.trim()))} className={`px-8 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${isRunning ? 'bg-red-600 text-white hover:bg-red-500' : isConfirming || !projectPath || !keywords.trim() ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none' : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20'}`}>
                        {isRunning ? (isCancelling ? <Loader2 className="animate-spin" size={18}/> : <X size={18}/>) : <ScanSearch size={18}/>}
                        {isRunning ? (isCancelling ? '正在回滚…' : '取消任务') : isConfirming ? '等待确认' : '开始选片'}
                    </button>}
                />
            </div>
        </div>
    );
};

const VideoSplitView = () => {
  const [videoPath, setVideoPath] = useState("");
  const { logs, isRunning, progress, statusMsg, start } = usePythonTask('cut_video.py', '等待输入...');

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // @ts-ignore
      const path = e.dataTransfer.files[0].path;
      if (path) {
        setVideoPath(path);
      }
    }
  };

  const startSplit = () => {
    if (!videoPath.trim()) return;
    start([videoPath], '正在启动处理...');
  };

  return (
    <div className="w-full space-y-6">
      <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Scissors size={24} /> 视频切割
      </h2>
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">

        <div className="space-y-2">
          <p className="mt-2 text-gray-600">
            无损将视频切割分为4GB为一个的视频文件。用于处理过长的花絮/素材文件。
          </p>
        </div>

        {/* Path Input */}
        <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-500 uppercase">目标视频文件</label>
            <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                    <Video size={18} />
                </div>
                <input
                  type="text"
                  value={videoPath}
                  onChange={(e) => setVideoPath(e.target.value)}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  placeholder="将 .mov / .mp4 视频文件拖入此处，或粘贴绝对路径"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-10 pr-4 py-3 text-slate-900 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm"
                />
            </div>
        </div>

        {/* Progress & Actions */}
        <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          idleMessage={statusMsg}
          action={<button
              onClick={startSplit}
              disabled={!videoPath || isRunning}
              className={`px-8 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${
                isRunning || !videoPath
                  ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none'
                  : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
              }`}
            >
              {isRunning ? <Loader2 className="animate-spin" size={18} /> : <Scissors size={18} fill="currentColor" />}
              {isRunning ? '切割中...' : '开始切割'}
            </button>}
        />
      </div>

    </div>
  );
};

// --- 组件 ---

export { DashboardView, HomePanel, ImportCard, ConverterView, ScreenshotMainImageView, ResearchView, MatchView, VideoSplitView };
