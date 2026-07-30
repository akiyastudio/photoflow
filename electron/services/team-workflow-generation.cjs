const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CANCELLED_CODE = 'EOPCANCELLED';

const cancelledError = () => Object.assign(new Error('工作流程生成已取消'), { code: CANCELLED_CODE });

const uniquePlannedDestination = (directory, fileName, reserved) => {
  const parsed = path.parse(fileName);
  let index = 1;
  let destination = path.join(directory, parsed.base);
  const key = value => process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  while (reserved.has(key(destination))) destination = path.join(directory, `${parsed.name} (${index++})${parsed.ext}`);
  reserved.add(key(destination));
  return destination;
};

const taskKey = (photoId, baseVersionId, taskId) => `${photoId}\0${baseVersionId}\0${taskId}`;

const mapWorkspaceTasks = workspace => {
  const tasks = new Map();
  for (const photo of workspace.photos || []) {
    for (const task of photo.tasks || []) tasks.set(taskKey(photo.photoId, photo.baseVersionId, task.id), task);
  }
  return tasks;
};

const runLimited = async (items, concurrency, callback) => {
  let cursor = 0;
  let firstError = null;
  const worker = async () => {
    while (!firstError) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await callback(items[index], index);
      } catch (error) {
        firstError = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, worker));
  if (firstError) throw firstError;
};

const buildWorkflowPlan = async ({
  groups,
  workspace,
  stagingDirectory,
  safeSegment,
  weekName,
  exists = fs.existsSync,
  stat = fs.promises.stat.bind(fs.promises),
}) => {
  const workspaceTasks = mapWorkspaceTasks(workspace);
  const assignments = new Map((workspace.assignments || []).map(item => [`${item.photoId}\0${item.baseVersionId}\0${Number(item.personIndex)}`, item]));
  const chainItems = new Map();
  for (const [groupIndex, group] of (groups || []).entries()) {
    for (const [itemIndex, item] of (group.items || []).entries()) {
      const current = chainItems.get(String(item.taskId)) || [];
      current.push({ ...item, week: Math.max(1, Math.floor(Number(group.week) || 1)), groupIndex, itemIndex });
      chainItems.set(String(item.taskId), current);
    }
  }
  const activeItems = new Map();
  for (const [taskId, items] of chainItems) {
    const ordered = items.sort((left, right) => left.week - right.week || left.groupIndex - right.groupIndex || left.itemIndex - right.itemIndex || Number(left.personIndex) - Number(right.personIndex));
    const activeIndex = ordered.findIndex(item => !assignments.get(`${item.photoId}\0${item.baseVersionId}\0${Number(item.personIndex)}`)?.completed);
    if (activeIndex < 0) continue;
    const active = ordered[activeIndex];
    const predecessorReturn = ordered.slice(0, activeIndex).reverse()
      .map(item => assignments.get(`${item.photoId}\0${item.baseVersionId}\0${Number(item.personIndex)}`)?.editedPatchPath)
      .find(filePath => filePath && exists(filePath));
    activeItems.set(`${taskId}\0${Number(active.personIndex)}`, { sourcePath: predecessorReturn || '', allowLegacyLatest: activeIndex > 0 });
  }
  const usedFoldersByWeek = new Map();
  const manifestGroups = [];
  const files = [];

  for (const group of groups || []) {
    const week = Math.max(1, Math.floor(Number(group.week) || 1));
    const usedFolders = usedFoldersByWeek.get(week) || new Set();
    const baseIdentityName = safeSegment(group.identityName, '未命名人物');
    let identityFolderName = baseIdentityName;
    let suffix = 2;
    while (usedFolders.has(identityFolderName.toLocaleLowerCase())) identityFolderName = `${baseIdentityName}_${suffix++}`;
    usedFolders.add(identityFolderName.toLocaleLowerCase());
    usedFoldersByWeek.set(week, usedFolders);
    const groupDirectory = path.join(stagingDirectory, weekName(week), identityFolderName);
    const reserved = new Set();
    const manifestItems = [];

    for (const item of group.items || []) {
      const task = workspaceTasks.get(taskKey(item.photoId, item.baseVersionId, item.taskId));
      if (!task) continue;
      const containsPerson = (task.members?.length ? task.members : [{ personIndex: task.personIndex }])
        .some(member => Number(member.personIndex) === Number(item.personIndex));
      if (!containsPerson) continue;
      const activeKey = `${item.taskId}\0${Number(item.personIndex)}`;
      const activeState = activeItems.get(activeKey);
      const sourcePath = activeState?.sourcePath
        || (activeState?.allowLegacyLatest && task.editedPatchPath && exists(task.editedPatchPath) ? task.editedPatchPath : task.patchPath);
      const baseName = `${safeSegment(item.photoName, '图片')}_人物${item.personIndex}${path.extname(sourcePath || task.patchPath) || '.png'}`;
      const destination = uniquePlannedDestination(groupDirectory, baseName, reserved);
      const manifestItem = { ...item, available: activeItems.has(activeKey), relativePath: path.relative(stagingDirectory, destination).replace(/\\/g, '/') };
      manifestItems.push(manifestItem);
      if (activeItems.has(activeKey) && sourcePath && exists(sourcePath)) {
        files.push({ sourcePath, destination, photoName: String(item.photoName || ''), personIndex: Number(item.personIndex) || 0 });
      }
    }
    if (manifestItems.length) {
      manifestGroups.push({
        week,
        identityId: String(group.identityId || ''),
        identityName: String(group.identityName || identityFolderName),
        relativePath: path.relative(stagingDirectory, groupDirectory).replace(/\\/g, '/'),
        items: manifestItems,
      });
    }
  }

  await runLimited(files, 12, async file => {
    const sourceStat = await stat(file.sourcePath);
    if (!sourceStat.isFile()) throw new Error(`工作图不是普通文件：${path.basename(file.sourcePath)}`);
    file.size = sourceStat.size;
    file.mtimeMs = sourceStat.mtimeMs;
  });
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    groups: manifestGroups,
    files: files.map(file => ({ sourcePath: path.resolve(file.sourcePath), destination: path.relative(stagingDirectory, file.destination), size: file.size, mtimeMs: file.mtimeMs })),
  })).digest('hex');
  return { manifestGroups, files, totalBytes, fingerprint };
};

const copyWorkflowPlan = async ({
  files,
  totalBytes,
  copyFileAtomic,
  concurrency = 3,
  isCancelled = () => false,
  onProgress = () => undefined,
}) => {
  let completedFiles = 0;
  let copiedBytes = 0;
  const report = (file, phase = 'copying') => onProgress({
    phase,
    completedFiles,
    totalFiles: files.length,
    copiedBytes,
    totalBytes,
    currentName: file ? `${file.photoName || path.basename(file.sourcePath)} · 人物 ${file.personIndex}` : '',
  });

  const pendingFiles = [];
  for (const file of files) {
    if (isCancelled()) throw cancelledError();
    let reusable = false;
    try {
      const destinationStat = await fs.promises.stat(file.destination);
      reusable = destinationStat.isFile()
        && destinationStat.size === file.size
        && Math.abs(destinationStat.mtimeMs - file.mtimeMs) < 2000;
    } catch {
      reusable = false;
    }
    if (reusable) {
      completedFiles += 1;
      copiedBytes += file.size;
      report(file, 'resuming');
    } else {
      await fs.promises.rm(file.destination, { force: true }).catch(() => undefined);
      pendingFiles.push(file);
    }
  }

  let firstError = null;
  let cursor = 0;
  const worker = async () => {
    while (!firstError && !isCancelled()) {
      const index = cursor++;
      if (index >= pendingFiles.length) return;
      const file = pendingFiles[index];
      let fileBytes = 0;
      try {
        await copyFileAtomic(file.sourcePath, file.destination, {
          isCancelled,
          onProgress: value => {
            const currentBytes = Math.max(0, Math.min(file.size, Number(value.bytesCopied) || 0));
            copiedBytes += Math.max(0, currentBytes - fileBytes);
            fileBytes = currentBytes;
            report(file);
          },
        });
        if (fileBytes < file.size) copiedBytes += file.size - fileBytes;
        completedFiles += 1;
        report(file);
      } catch (error) {
        firstError = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pendingFiles.length || 1)) }, worker));
  if (isCancelled()) throw cancelledError();
  if (firstError) throw firstError;
  report(null, 'finalizing');
  return { completedFiles, copiedBytes };
};

module.exports = {
  CANCELLED_CODE,
  buildWorkflowPlan,
  copyWorkflowPlan,
  mapWorkspaceTasks,
};
