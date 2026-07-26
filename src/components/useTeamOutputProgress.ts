import { useEffect, useState } from 'react';
import type { ProgressFolder, WorkspaceProject } from '../types';

const normalizeDirectory = (value = '') => value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
const parentDirectory = (value = '') => value.replace(/[\\/][^\\/]+$/, '');
const compareProgressKeys = (left: string, right: string) => {
  const leftParts = left.split('_').map(Number);
  const rightParts = right.split('_').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if ((leftParts[index] ?? -1) !== (rightParts[index] ?? -1)) return (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
  }
  return 0;
};

export const useTeamOutputProgress = (sourceFilePath: string, workspacePath: string, project: WorkspaceProject, onNotice: (message: string) => void) => {
  const [folders, setFolders] = useState<ProgressFolder[]>([]);
  const [sourceProgress, setSourceProgress] = useState<ProgressFolder>();
  const [targetProgressId, setTargetProgressIdState] = useState('__new__');
  const sourceDirectory = normalizeDirectory(parentDirectory(sourceFilePath));
  const storageKey = `photoflow:team-retouch-output:${workspacePath}|${project.name}|${sourceProgress?.id || sourceDirectory}`;

  useEffect(() => {
    let active = true;
    void window.electronAPI.getProgressFolders(workspacePath, project.name).then(result => {
      if (!active || !result.success) return;
      const imageFolders = result.progressFolders.filter(folder => folder.mediaKind === 'image');
      const source = imageFolders.find(folder => normalizeDirectory(folder.folderPath) === sourceDirectory);
      const candidates = imageFolders.filter(folder => !folder.folderMissing && normalizeDirectory(folder.folderPath) !== sourceDirectory);
      const remembered = candidates.find(folder => folder.id === (window.localStorage.getItem(`photoflow:team-retouch-output:${workspacePath}|${project.name}|${source?.id || sourceDirectory}`) || ''));
      const related = [...candidates].reverse().find(folder => folder.parentProgressId === source?.id && folder.displayName.includes('团片协作合成'));
      setFolders(imageFolders);
      setSourceProgress(source);
      setTargetProgressIdState(remembered?.id || related?.id || '__new__');
    }).catch(error => onNotice(`读取合成目标失败：${error instanceof Error ? error.message : String(error)}`));
    return () => { active = false; };
  }, [sourceDirectory, workspacePath, project.name, onNotice]);

  const setTargetProgressId = (value: string) => {
    setTargetProgressIdState(value);
    if (value === '__new__') window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, value);
  };

  const ensureTargetProgress = async () => {
    const selected = folders.find(folder => folder.id === targetProgressId && !folder.folderMissing && normalizeDirectory(folder.folderPath) !== sourceDirectory);
    if (selected) return selected;
    const latest = await window.electronAPI.getProgressFolders(workspacePath, project.name);
    if (!latest.success) throw new Error(latest.error || '无法读取项目进度');
    const imageFolders = latest.progressFolders.filter(folder => folder.mediaKind === 'image');
    const latestSource = imageFolders.find(folder => normalizeDirectory(folder.folderPath) === sourceDirectory);
    const nextRoot = imageFolders.filter(folder => !folder.versionKey.includes('_')).reduce((highest, folder) => Math.max(highest, Number(folder.versionKey) || 0), 0) + 1;
    const created = await window.electronAPI.createProgressFolder(workspacePath, project.status, project.name, { mediaKind: 'image', versionKey: String(nextRoot), parentProgressId: latestSource?.id || sourceProgress?.id, displayName: `图片后期_${nextRoot}_团片协作合成` });
    if (!created.success || !created.progressFolder) throw new Error(created.error || '无法新建合成目标进度');
    setFolders(current => [...current, created.progressFolder as ProgressFolder]);
    setTargetProgressIdState(created.progressFolder.id);
    window.localStorage.setItem(`photoflow:team-retouch-output:${workspacePath}|${project.name}|${latestSource?.id || sourceDirectory}`, created.progressFolder.id);
    return created.progressFolder;
  };

  return { folders: folders.filter(folder => !folder.folderMissing && normalizeDirectory(folder.folderPath) !== sourceDirectory).sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)), targetProgressId, setTargetProgressId, ensureTargetProgress };
};
