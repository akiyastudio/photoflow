import type { ProgressFolder } from '../../types';

export type VersionPanelKind = 'create' | 'import' | 'modify' | 'confirm';
export type VersionPanelState = 'ready' | 'move_confirm' | 'processing' | 'waiting_confirmation' | 'loading' | 'committing' | 'result' | 'failure';
export type VersionRelationKind = 'main' | 'auxiliary';
export type VersionTrackingPolicy = Pick<ProgressFolder, 'trackingEnabled' | 'renameFromParent' | 'copyMissingFromParent'>;

export const VERSION_PANEL_DEFINITIONS: Record<VersionPanelKind, { title: string; states: readonly VersionPanelState[] }> = {
  create: { title: '新建进度', states: ['ready', 'processing', 'result', 'failure'] },
  import: { title: '导入进度', states: ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure'] },
  modify: { title: '修改进度', states: ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure'] },
  confirm: { title: '确认跟踪图片', states: ['loading', 'waiting_confirmation', 'committing', 'result', 'failure'] },
};

export const normalizeVersionPath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export const normalizeTrackingPolicy = (relationKind: VersionRelationKind, requested: Partial<VersionTrackingPolicy>): VersionTrackingPolicy => {
  if (relationKind === 'auxiliary') return { trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false };
  const trackingEnabled = Boolean(requested.trackingEnabled);
  return {
    trackingEnabled,
    renameFromParent: trackingEnabled && Boolean(requested.renameFromParent),
    copyMissingFromParent: trackingEnabled && Boolean(requested.copyMissingFromParent),
  };
};

export const normalizeProgressSetupTrackingPolicy = (relationKind: VersionRelationKind, requested: {
  trackingEnabled?: boolean;
  renameSources?: boolean;
  copyMissingFromParent?: boolean;
}): VersionTrackingPolicy => normalizeTrackingPolicy(relationKind, {
  trackingEnabled: requested.trackingEnabled,
  renameFromParent: requested.renameSources,
  copyMissingFromParent: requested.copyMissingFromParent,
});

export const versionNodeRole = (relationKind: VersionRelationKind): ProgressFolder['nodeRole'] => relationKind === 'auxiliary' ? 'selection' : 'progress';

export const trackingStateLabel = (folder: Pick<ProgressFolder, 'nodeRole' | 'trackingState'>) => {
  if (folder.nodeRole === 'original') return '原始素材';
  if (folder.trackingState === 'disabled') return '未跟踪';
  if (folder.trackingState === 'ready') return '已跟踪';
  if (folder.trackingState === 'stale') return '待刷新';
  if (folder.trackingState === 'needs_repair') return '版本关系需要修复';
  return '跟踪处理中';
};

export const progressTrackingAction = (folder: ProgressFolder): 'refresh' | 'resume' | 'repair' | null => {
  if (folder.folderMissing || folder.nodeRole === 'selection' || folder.relationKind === 'auxiliary') return null;
  if (folder.trackingState === 'needs_repair') return 'repair';
  if (folder.trackingState === 'pending_compare' || folder.trackingState === 'pending_confirm' || folder.trackingState === 'committing') return 'resume';
  return 'refresh';
};

export const progressTrackingActionLabel = (folder: ProgressFolder) => {
  const action = progressTrackingAction(folder);
  if (action === 'repair') return '修复版本关系';
  if (action === 'resume') return '继续版本跟踪';
  return action === 'refresh' ? '刷新版本跟踪' : '';
};

export const requiresProgressRootMove = (relativePath: string, nodeRole: ProgressFolder['nodeRole']) => nodeRole === 'progress' && normalizeVersionPath(relativePath).includes('/');

export const planProgressRootMove = (relativePath: string) => {
  const sourceRelativePath = normalizeVersionPath(relativePath);
  const targetRelativePath = sourceRelativePath.split('/').pop() || '';
  return { sourceRelativePath, targetRelativePath, requiresMove: Boolean(targetRelativePath && sourceRelativePath !== targetRelativePath) };
};

export const selectableVersionParents = (folders: ProgressFolder[], draft: { mediaKind: ProgressFolder['mediaKind']; relationKind: VersionRelationKind; existingProgressId?: string }) => {
  const byParent = new Map<string, string[]>();
  folders.forEach(folder => {
    if (!folder.parentProgressId) return;
    const children = byParent.get(folder.parentProgressId) || [];
    children.push(folder.id);
    byParent.set(folder.parentProgressId, children);
  });
  const excluded = new Set<string>();
  const stack = draft.existingProgressId ? [draft.existingProgressId] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (excluded.has(id)) continue;
    excluded.add(id);
    stack.push(...(byParent.get(id) || []));
  }
  return folders.filter(folder => !folder.folderMissing
    && folder.mediaKind === draft.mediaKind
    && !excluded.has(folder.id)
    && folder.nodeRole !== 'selection'
    && folder.relationKind !== 'auxiliary');
};

export type VisibleVersionEdge = { parentId: string; childId: string; relationKind: VersionRelationKind };
export type VisibleVersionGraph = { folders: ProgressFolder[]; edges: VisibleVersionEdge[]; cycleNodeIds: string[] };

export const projectVisibleVersionGraph = (folders: ProgressFolder[]): VisibleVersionGraph => {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const visible = folders.filter(folder => !folder.folderMissing);
  const cycleNodeIds = new Set<string>();
  const edges: VisibleVersionEdge[] = [];
  for (const start of folders) {
    const order = new Map<string, number>();
    const chain: string[] = [];
    let cursor: ProgressFolder | undefined = start;
    while (cursor) {
      const repeatedAt = order.get(cursor.id);
      if (repeatedAt !== undefined) {
        chain.slice(repeatedAt).forEach(id => cycleNodeIds.add(id));
        break;
      }
      order.set(cursor.id, chain.length);
      chain.push(cursor.id);
      cursor = cursor.parentProgressId ? byId.get(cursor.parentProgressId) : undefined;
    }
  }
  for (const folder of visible) {
    let parentId = folder.parentProgressId;
    const visited = new Set([folder.id]);
    while (parentId) {
      if (visited.has(parentId)) { visited.forEach(id => cycleNodeIds.add(id)); parentId = undefined; break; }
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) { parentId = undefined; break; }
      if (!parent.folderMissing) {
        if (cycleNodeIds.has(parent.id) || cycleNodeIds.has(folder.id)) parentId = undefined;
        break;
      }
      // Auxiliary descendants do not jump across a missing source. Main
      // descendants reconnect only through main ancestors.
      if (folder.relationKind === 'auxiliary') { parentId = undefined; break; }
      parentId = parent.relationKind === 'auxiliary' || parent.nodeRole === 'selection' ? undefined : parent.parentProgressId;
    }
    if (parentId) edges.push({ parentId, childId: folder.id, relationKind: folder.relationKind || 'main' });
  }
  return { folders: visible, edges, cycleNodeIds: [...cycleNodeIds] };
};

export const selectionOutputName = (sourceRelativePath: string) => {
  const name = normalizeVersionPath(sourceRelativePath).split('/').pop() || '';
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('来源文件夹名无效');
  return `${name}_选片`;
};
