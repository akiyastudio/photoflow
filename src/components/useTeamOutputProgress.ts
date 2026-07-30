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

export const useTeamOutputProgress = (sourceFilePaths: string | string[], workspacePath: string, project: WorkspaceProject, onNotice: (message: string) => void) => {
  const [folders, setFolders] = useState<ProgressFolder[]>([]);
  const [sourceProgress, setSourceProgress] = useState<ProgressFolder>();
  const [targetProgressId, setTargetProgressIdState] = useState('__new__');
  const sourceDirectories = [...new Set((Array.isArray(sourceFilePaths) ? sourceFilePaths : [sourceFilePaths]).filter(Boolean).map(filePath => normalizeDirectory(parentDirectory(filePath))))];
  const sourceDirectoryKey = sourceDirectories.join('|');
  const storageKey = `photoflow:team-retouch-output:${workspacePath}|${project.name}|${sourceProgress?.id || sourceDirectoryKey}`;
  const disabledReason = (folder: ProgressFolder, boundary = sourceProgress) => {
    if (folder.folderMissing) return '文件夹不存在';
    if (boundary && folder.id === boundary.id) return '当前来源，不可选择';
    if (boundary && compareProgressKeys(folder.versionKey, boundary.versionKey) <= 0) return '早于当前来源，不可选择';
    if (!boundary && sourceDirectories.includes(normalizeDirectory(folder.folderPath))) return '当前来源，不可选择';
    return '';
  };

  useEffect(() => {
    let active = true;
    void window.electronAPI.getProgressFolders(workspacePath, project.name).then(result => {
      if (!active || !result.success) return;
      const imageFolders = result.progressFolders.filter(folder => folder.mediaKind === 'image');
      const sources = imageFolders.filter(folder => sourceDirectories.includes(normalizeDirectory(folder.folderPath)));
      const source = [...sources].sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)).at(-1);
      const reasonFor = (folder: ProgressFolder) => {
        if (folder.folderMissing) return 'missing';
        if (source && compareProgressKeys(folder.versionKey, source.versionKey) <= 0) return 'not-newer';
        if (!source && sourceDirectories.includes(normalizeDirectory(folder.folderPath))) return 'source';
        return '';
      };
      const candidates = imageFolders.filter(folder => !reasonFor(folder));
      const rememberedKey = `photoflow:team-retouch-output:${workspacePath}|${project.name}|${source?.id || sourceDirectoryKey}`;
      const remembered = candidates.find(folder => folder.id === (window.localStorage.getItem(rememberedKey) || ''));
      const related = [...candidates].reverse().find(folder => folder.parentProgressId === source?.id && folder.displayName.includes('团片协作合成'));
      setFolders(imageFolders);
      setSourceProgress(source);
      setTargetProgressIdState(remembered?.id || related?.id || '__new__');
    }).catch(error => onNotice(`读取合成目标失败：${error instanceof Error ? error.message : String(error)}`));
    return () => { active = false; };
  }, [sourceDirectoryKey, workspacePath, project.name, onNotice]);

  const setTargetProgressId = (value: string) => {
    const selected = folders.find(folder => folder.id === value);
    if (value !== '__new__' && (!selected || disabledReason(selected))) return;
    setTargetProgressIdState(value);
    if (value === '__new__') window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, value);
  };

  const ensureTargetProgress = async () => {
    const selected = folders.find(folder => folder.id === targetProgressId && !disabledReason(folder));
    if (selected) return selected;
    const latest = await window.electronAPI.getProgressFolders(workspacePath, project.name);
    if (!latest.success) throw new Error(latest.error || '无法读取项目进度');
    const imageFolders = latest.progressFolders.filter(folder => folder.mediaKind === 'image');
    const latestSources = imageFolders.filter(folder => sourceDirectories.includes(normalizeDirectory(folder.folderPath)));
    const latestSource = [...latestSources].sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)).at(-1);
    const nextRoot = imageFolders.filter(folder => !folder.versionKey.includes('_')).reduce((highest, folder) => Math.max(highest, Number(folder.versionKey) || 0), 0) + 1;
    const created = await window.electronAPI.createProgressFolder(workspacePath, project.status, project.name, { mediaKind: 'image', versionKey: String(nextRoot), parentProgressId: latestSource?.id || sourceProgress?.id, displayName: `图片后期_${nextRoot}_团片协作合成` });
    if (!created.success || !created.progressFolder) throw new Error(created.error || '无法新建合成目标进度');
    setFolders(current => [...current, created.progressFolder as ProgressFolder]);
    setTargetProgressIdState(created.progressFolder.id);
    window.localStorage.setItem(`photoflow:team-retouch-output:${workspacePath}|${project.name}|${latestSource?.id || sourceDirectoryKey}`, created.progressFolder.id);
    return created.progressFolder;
  };

  return {
    folders: [...folders].sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)),
    progressOptions: [...folders].sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)).map(folder => ({ folder, disabled: Boolean(disabledReason(folder)), reason: disabledReason(folder) })),
    targetProgressId,
    setTargetProgressId,
    ensureTargetProgress,
  };
};
