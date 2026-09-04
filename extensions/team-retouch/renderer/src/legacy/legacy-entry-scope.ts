type Json = Record<string, any>;

const normalizedKey = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
const fileName = (value: string) => value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || value;

/** Historical semantics: persisted team photos first, then the current explicit image selection. */
export const teamRetouchEntriesForOpen = (workspace: Json, selectedRelativePaths: string[]) => {
  return resolveTeamRetouchEntriesForOpen(workspace, selectedRelativePaths).entries;
};

export const resolveTeamRetouchEntriesForOpen = (workspace: Json, selectedRelativePaths: string[]) => {
  const entries: Json[] = [];
  const usedPaths = new Set<string>();
  const photos = workspace.photos || [];
  const historyPhotoCount = photos.length;
  const ownershipPendingCount = 0;
  let resolvedHistoryCount = 0;
  let missingHistoryCount = 0;
  let unresolvedPathCount = 0;
  let historyTaskCount = 0;
  for (const [index, photo] of photos.entries()) {
    const relativePath = String(photo.relativePath || '');
    historyTaskCount += Array.isArray(photo.tasks) ? photo.tasks.length : 0;
    const key = normalizedKey(relativePath);
    const sourceMissing = photo.fileMissing === true;
    if (relativePath && !usedPaths.has(key) && !sourceMissing) {
      usedPaths.add(key); resolvedHistoryCount += 1;
      entries.push({ kind: 'image', name: photo.displayName || fileName(relativePath), path: relativePath, relativePath, teamHistoryPhotoId: photo.photoId, teamHistoryBaseVersionId: photo.baseVersionId, teamHistoryTaskCount: photo.tasks?.length || 0 });
    } else {
      missingHistoryCount += 1;
      if (!relativePath || usedPaths.has(key)) unresolvedPathCount += 1;
      else { usedPaths.add(key); resolvedHistoryCount += 1; }
      const identity = encodeURIComponent(String(photo.photoId || `${index + 1}`));
      entries.push({ kind: 'image', name: photo.displayName || fileName(relativePath) || `团片历史图片 ${index + 1}`, path: '', relativePath: `__photoflow_missing_team_history__/${identity}`, teamHistoryMissing: true, teamHistoryOriginalRelativePath: relativePath, teamHistoryPhotoId: photo.photoId, teamHistoryBaseVersionId: photo.baseVersionId, teamHistoryTaskCount: photo.tasks?.length || 0, teamHistoryMissingReason: sourceMissing ? '项目文件已删除、离线或暂时无法定位' : relativePath ? '当前路径重复，无法唯一关联' : '当前记录缺少项目内相对路径' });
    }
  }
  for (const value of selectedRelativePaths || []) {
    const relativePath = String(value || '');
    const key = normalizedKey(relativePath);
    if (relativePath && !usedPaths.has(key) && !relativePath.startsWith('__photoflow_missing_team_history__/')) { usedPaths.add(key); entries.push({ kind: 'image', name: fileName(relativePath), path: relativePath, relativePath }); }
  }
  return { entries, historyPhotoCount, returnedPhotoCount: photos.length, ownershipPendingCount, resolvedHistoryCount, missingHistoryCount, unresolvedPathCount, historyTaskCount };
};
