// @ts-nocheck -- source-faithful migration from fef15e4^; RPC types are enforced by legacy-api.ts
import { legacyApi } from './legacy-api';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProgressFolder, TeamProjectPhoto, WorkspaceProject } from './legacy-types';
import { resolveLegacyTeamSourceProgressIds } from './legacy-progress-scope';
import { normalizeLegacyProgressResult } from './legacy-progress-result-model';

const normalizePath = (value = '') => value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();

const compareProgressKeys = (left: string, right: string) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' });

export const isTeamSourceProgressCandidate = (folder: ProgressFolder) => folder.mediaKind === 'image'
  && !folder.folderMissing
  && folder.relationKind !== 'auxiliary'
  && folder.nodeRole === 'progress';

export const isTeamProgressCandidate = (folder: ProgressFolder) => isTeamSourceProgressCandidate(folder)
  && folder.nodeRole === 'progress';

export const resolveTeamSourceProgressIds = resolveLegacyTeamSourceProgressIds;

/** Only photos that produced at least one AI crop are real team-workflow inputs. */
export const teamWorkflowSourcePaths = (photos: TeamProjectPhoto[]) => photos
  .filter(photo => photo.tasks.length > 0)
  .map(photo => photo.sourcePath);

export const useTeamOutputProgress = (sourceFilePaths: string | string[], workspacePath: string, project: WorkspaceProject, onNotice: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void) => {
  const normalizedSourcePaths = useMemo(
    () => [...new Set((Array.isArray(sourceFilePaths) ? sourceFilePaths : [sourceFilePaths]).filter(Boolean))],
    [Array.isArray(sourceFilePaths) ? sourceFilePaths.join('|') : sourceFilePaths],
  );
  const sourcePathKey = normalizedSourcePaths.map(normalizePath).join('|');
  const [folders, setFolders] = useState<ProgressFolder[]>([]);
  const [sourceProgressIds, setSourceProgressIds] = useState<string[]>([]);
  const [targetProgressId, setTargetProgressIdState] = useState('__new__');
  const sourceProgressKey = sourceProgressIds.join('|') || sourcePathKey;
  const storageKey = `photoflow:team-retouch-output:${workspacePath}|${project.name}|${sourceProgressKey}`;

  const disabledReason = useCallback((folder: ProgressFolder) => {
    if (folder.folderMissing) return '文件夹不存在';
    if (!isTeamProgressCandidate(folder)) return '不是主进度或合法原始来源';
    if (sourceProgressIds.includes(folder.id)) return '当前来源，不可选择';
    return '';
  }, [sourceProgressKey]);

  const refresh = useCallback(async () => {
    const result = normalizeLegacyProgressResult(await legacyApi.getProgressFolders(workspacePath, project.name));
    if (!result.success) throw new Error(result.error || '无法读取项目进度');
    const { progressFolders, graphEdges } = result;
    const sources = resolveTeamSourceProgressIds(normalizedSourcePaths, progressFolders);
    const candidates = progressFolders.filter(folder => isTeamProgressCandidate(folder) && !sources.includes(folder.id));
    const rememberedKey = `photoflow:team-retouch-output:${workspacePath}|${project.name}|${sources.join('|') || sourcePathKey}`;
    const remembered = candidates.find(folder => folder.id === (window.localStorage.getItem(rememberedKey) || ''));
    const workflowOutputIds = new Set(graphEdges
      .filter(edge => edge.edgeKind === 'workflow_input')
      .filter(edge => progressFolders.some(folder => folder.id === edge.sourceProgressId && folder.nodeRole === 'workflow'))
      .map(edge => edge.targetProgressId));
    const related = [...candidates].reverse().find(folder => workflowOutputIds.has(folder.id));
    setFolders(progressFolders);
    setSourceProgressIds(sources);
    setTargetProgressIdState(current => {
      if (current !== '__new__' && candidates.some(folder => folder.id === current)) return current;
      return remembered?.id || related?.id || '__new__';
    });
    return { ...result, progressFolders, graphEdges, sourceProgressIds: sources };
  }, [workspacePath, project.name, sourcePathKey]);

  useEffect(() => {
    let active = true;
    void refresh().catch(error => {
      if (active) onNotice(`读取合成目标失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    });
    return () => { active = false; };
  }, [refresh, onNotice]);

  const setTargetProgressId = (value: string) => {
    const selected = folders.find(folder => folder.id === value);
    if (value !== '__new__' && (!selected || disabledReason(selected))) return;
    setTargetProgressIdState(value);
    if (value === '__new__') window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, value);
  };

  const ensureWorkflowInputs = useCallback(async (workflowProgressId?: string) => {
    if (!workflowProgressId) return;
    const latest = await refresh();
    const registered = await legacyApi.registerProgressWithGraph(workspacePath, project.status, {
      projectName: project.name,
      progress: { progressId: workflowProgressId },
      workflowInputProgressIds: latest.sourceProgressIds,
    });
    if (!registered.success) throw new Error(registered.error || '无法登记团片来源关系');
  }, [refresh, workspacePath, project.status, project.name]);

  const ensureTargetProgress = async (workflowProgressId?: string) => {
    if (!workflowProgressId) throw new Error('团片协作工作流节点尚未建立');
    const latest = await refresh();
    const selected = latest.progressFolders.find(folder => folder.id === targetProgressId && isTeamProgressCandidate(folder) && !latest.sourceProgressIds.includes(folder.id));
    const roots = latest.progressFolders.filter(folder => isTeamProgressCandidate(folder) && folder.nodeRole === 'progress' && !folder.versionKey.includes('_'));
    const nextRoot = roots.reduce((highest, folder) => Math.max(highest, Number(folder.versionKey) || 0), 0) + 1;
    const requestProgress = selected
      ? { progressId: selected.id }
      : {
        mediaKind: 'image' as const,
        versionKey: String(nextRoot),
        parentProgressId: latest.sourceProgressIds[0],
        displayName: `图片后期_${nextRoot}_团片协作合成`,
      };
    const registered = await legacyApi.registerProgressWithGraph(workspacePath, project.status, {
      projectName: project.name,
      progress: requestProgress,
      workflowInputProgressIds: [workflowProgressId],
    });
    if (!registered.success || !registered.progressFolder) throw new Error(registered.error || '无法提交团片输出进度关系');
    setFolders(current => current.some(folder => folder.id === registered.progressFolder!.id)
      ? current.map(folder => folder.id === registered.progressFolder!.id ? registered.progressFolder! : folder)
      : [...current, registered.progressFolder!]);
    setTargetProgressIdState(registered.progressFolder.id);
    window.localStorage.setItem(storageKey, registered.progressFolder.id);
    return registered.progressFolder;
  };

  return {
    folders: [...folders].sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)),
    progressOptions: [...folders].sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)).map(folder => ({ folder, disabled: Boolean(disabledReason(folder)), reason: disabledReason(folder) })),
    sourceProgressIds,
    targetProgressId,
    setTargetProgressId,
    ensureWorkflowInputs,
    ensureTargetProgress,
  };
};
