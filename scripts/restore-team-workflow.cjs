#!/usr/bin/env node

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const fail = message => {
  throw new Error(message);
};

const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const isInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const allItems = manifest => (manifest.groups || []).flatMap(group => group.items || []);

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const projectNameOption = option('project-name');
const statusOption = option('status');
const databaseOption = option('database');
const projectIdOption = option('project-id');
const values = args.filter(value => value !== '--apply' && !value.startsWith('--'));
if (values.length !== 3) {
  console.error('Usage: node scripts/restore-team-workflow.cjs [--apply] [--project-name=NAME --status=STATUS --database=PATH --project-id=ID] <legacy-manifest> <current-manifest> <project-directory>');
  process.exit(2);
}

const [legacyManifestPath, currentManifestPath, projectDirectory] = values.map(value => path.resolve(value));
const outputDirectory = path.join(projectDirectory, '团片协作');
const legacy = readJson(legacyManifestPath);
const currentManifestExists = fs.existsSync(currentManifestPath);
if (!currentManifestExists && (!projectNameOption || !statusOption)) fail('A missing current manifest requires --project-name and --status.');
const current = currentManifestExists
  ? readJson(currentManifestPath)
  : { version: 2, projectName: projectNameOption, status: statusOption, groups: [] };
let workflowState = null;
if (databaseOption || projectIdOption) {
  if (!databaseOption || !projectIdOption) fail('--database and --project-id must be provided together.');
  const stateScript = path.join(__dirname, 'read-team-workflow-state.py');
  const stateOutput = childProcess.execFileSync('python', [stateScript, '--database', path.resolve(databaseOption), '--project-id', projectIdOption], { encoding: 'utf8' });
  workflowState = JSON.parse(stateOutput);
}

if (Number(legacy.version) !== 1) fail('The source manifest is not a legacy V1 workflow.');
if (Number(current.version) < 2) fail('The current manifest is not a V2 workflow.');
if (!fs.statSync(projectDirectory).isDirectory()) fail('The project directory does not exist.');
if (!fs.statSync(outputDirectory).isDirectory()) fail('The current workflow directory does not exist.');

const legacyItems = allItems(legacy);
const currentItems = allItems(current);
const legacyTaskIds = new Set(legacyItems.map(item => String(item.taskId || '')).filter(Boolean));
const currentTaskIds = new Set(currentItems.map(item => String(item.taskId || '')).filter(Boolean));
if (currentManifestExists && (legacyTaskIds.size !== currentTaskIds.size || [...legacyTaskIds].some(taskId => !currentTaskIds.has(taskId)))) {
  fail(`The workflow task sets differ (legacy ${legacyTaskIds.size}, current ${currentTaskIds.size}).`);
}
if (workflowState) {
  const stateTaskIds = new Set(Object.keys(workflowState.tasks || {}));
  if (legacyTaskIds.size !== stateTaskIds.size || [...legacyTaskIds].some(taskId => !stateTaskIds.has(taskId))) {
    fail(`The workflow and database task sets differ (legacy ${legacyTaskIds.size}, database ${stateTaskIds.size}).`);
  }
}

const sourceByTaskId = new Map();
const availableItemKeys = new Set();
let completedAssignments = 0;
let allCompletedTasks = 0;
if (workflowState) {
  const assignmentKey = item => `${item.photoId}\0${item.baseVersionId}\0${Number(item.personIndex)}`;
  const assignments = new Map((workflowState.assignments || []).map(assignment => [assignmentKey(assignment), assignment]));
  const chains = new Map();
  for (const [groupIndex, group] of (legacy.groups || []).entries()) {
    for (const [itemIndex, item] of (group.items || []).entries()) {
      const taskId = String(item.taskId || '');
      if (!chains.has(taskId)) chains.set(taskId, []);
      chains.get(taskId).push({ item, groupIndex, itemIndex });
    }
  }
  for (const [taskId, chain] of chains) {
    let sourcePath = workflowState.tasks[taskId]?.patchPath;
    let availableEntry = null;
    for (const entry of chain) {
      const assignment = assignments.get(assignmentKey(entry.item));
      if (!assignment?.completed) {
        availableEntry = entry;
        break;
      }
      completedAssignments += 1;
      if (assignment.completionKind === 'returned' && assignment.editedPatchPath) sourcePath = assignment.editedPatchPath;
    }
    if (!availableEntry) {
      allCompletedTasks += 1;
      continue;
    }
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) fail(`The relay source for task ${taskId} is missing: ${sourcePath}`);
    sourceByTaskId.set(taskId, sourcePath);
    availableItemKeys.add(`${availableEntry.groupIndex}\0${availableEntry.itemIndex}`);
  }
} else {
  for (const item of currentItems.filter(item => item.available)) {
    const taskId = String(item.taskId || '');
    if (!taskId || sourceByTaskId.has(taskId)) fail(`Task ${taskId || '(missing id)'} has more than one available current file.`);
    const sourcePath = path.resolve(outputDirectory, String(item.relativePath || ''));
    if (!isInside(outputDirectory, sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      fail(`The current source file for task ${taskId} is missing or unsafe: ${sourcePath}`);
    }
    sourceByTaskId.set(taskId, sourcePath);
  }
}
if (!workflowState && sourceByTaskId.size !== legacyTaskIds.size) {
  fail(`Expected ${legacyTaskIds.size} available source files, found ${sourceByTaskId.size}.`);
}

const availableTaskIds = new Set();
const destinationPaths = new Set();
const restoredGroups = (legacy.groups || []).map((group, groupIndex) => ({
  ...group,
  items: (group.items || []).map((item, itemIndex) => {
    const taskId = String(item.taskId || '');
    const available = workflowState ? availableItemKeys.has(`${groupIndex}\0${itemIndex}`) : !availableTaskIds.has(taskId);
    let relativePath = item.relativePath;
    if (available) {
      availableTaskIds.add(taskId);
      const sourceExtension = path.extname(sourceByTaskId.get(taskId)).toLowerCase();
      if (sourceExtension) {
        const parsed = path.posix.parse(String(relativePath || '').replace(/\\/g, '/'));
        relativePath = path.posix.join(parsed.dir, `${parsed.name}${sourceExtension}`);
      }
      const destinationPath = path.resolve(outputDirectory, String(relativePath || ''));
      const destinationKey = destinationPath.toLocaleLowerCase();
      if (!isInside(outputDirectory, destinationPath)) fail(`Unsafe legacy destination for task ${taskId}: ${destinationPath}`);
      if (destinationPaths.has(destinationKey)) fail(`Two tasks target the same restored file: ${destinationPath}`);
      destinationPaths.add(destinationKey);
    }
    return { ...item, available, relativePath };
  }),
}));

const restoredManifest = {
  ...legacy,
  version: 2,
  projectName: current.projectName,
  status: current.status,
  generatedAt: Date.now(),
  restoredFrom: {
    projectName: legacy.projectName,
    generatedAt: legacy.generatedAt,
    manifestVersion: legacy.version,
  },
  groups: restoredGroups,
};

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  projectDirectory,
  legacyProjectName: legacy.projectName,
  currentProjectName: current.projectName,
  groups: restoredGroups.length,
  taskOccurrences: legacyItems.length,
  uniqueTasks: legacyTaskIds.size,
  initiallyAvailable: availableTaskIds.size,
  completedAssignments,
  allCompletedTasks,
  currentManifestExisted: currentManifestExists,
};

if (!apply) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const suffix = crypto.randomUUID().slice(0, 8);
const backupDirectory = path.join(projectDirectory, `.photoflow-team-workflow-backup-${stamp}-${suffix}`);
const stagingDirectory = path.join(projectDirectory, `.photoflow-team-workflow-restore-${suffix}`);
const backupWorkflowDirectory = path.join(backupDirectory, '团片协作-current');
const pendingManifestPath = `${currentManifestPath}.${suffix}.restore.tmp`;
const originalManifestPath = `${currentManifestPath}.${suffix}.restore-backup`;
let manifestMovedToBackup = false;
const movedOriginalEntries = [];
const installedEntries = [];

try {
  fs.mkdirSync(backupDirectory, { recursive: false });
  if (currentManifestExists) fs.copyFileSync(currentManifestPath, path.join(backupDirectory, 'current-manifest.json'));
  else fs.writeFileSync(path.join(backupDirectory, 'current-manifest-was-missing.txt'), `${currentManifestPath}\n`, 'utf8');
  fs.copyFileSync(legacyManifestPath, path.join(backupDirectory, 'legacy-manifest.json'));
  fs.mkdirSync(backupWorkflowDirectory, { recursive: false });
  fs.mkdirSync(stagingDirectory, { recursive: false });

  for (const group of restoredGroups) {
    for (const item of group.items || []) {
      if (!item.available) continue;
      const sourcePath = sourceByTaskId.get(String(item.taskId));
      const destinationPath = path.resolve(stagingDirectory, String(item.relativePath || ''));
      if (!isInside(stagingDirectory, destinationPath)) fail(`Unsafe staging destination: ${destinationPath}`);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    }
  }

  fs.writeFileSync(pendingManifestPath, JSON.stringify(restoredManifest, null, 2), { encoding: 'utf8', flag: 'wx' });
  for (const name of fs.readdirSync(outputDirectory)) {
    fs.renameSync(path.join(outputDirectory, name), path.join(backupWorkflowDirectory, name));
    movedOriginalEntries.push(name);
  }
  for (const name of fs.readdirSync(stagingDirectory)) {
    fs.renameSync(path.join(stagingDirectory, name), path.join(outputDirectory, name));
    installedEntries.push(name);
  }
  if (currentManifestExists) {
    fs.renameSync(currentManifestPath, originalManifestPath);
    manifestMovedToBackup = true;
  }
  try {
    fs.renameSync(pendingManifestPath, currentManifestPath);
  } catch (error) {
    if (manifestMovedToBackup) {
      fs.renameSync(originalManifestPath, currentManifestPath);
      manifestMovedToBackup = false;
    }
    throw error;
  }
  if (manifestMovedToBackup) fs.rmSync(originalManifestPath, { force: true });
  manifestMovedToBackup = false;
  fs.rmSync(stagingDirectory, { recursive: true, force: true });

  console.log(JSON.stringify({ ...summary, backupDirectory, restoredManifestPath: currentManifestPath }, null, 2));
} catch (error) {
  try {
    for (const name of [...installedEntries].reverse()) {
      const installedPath = path.join(outputDirectory, name);
      const stagedPath = path.join(stagingDirectory, name);
      if (fs.existsSync(installedPath) && !fs.existsSync(stagedPath)) fs.renameSync(installedPath, stagedPath);
    }
    for (const name of [...movedOriginalEntries].reverse()) {
      const backupPath = path.join(backupWorkflowDirectory, name);
      const originalPath = path.join(outputDirectory, name);
      if (fs.existsSync(backupPath) && !fs.existsSync(originalPath)) fs.renameSync(backupPath, originalPath);
    }
    if (manifestMovedToBackup && !fs.existsSync(currentManifestPath) && fs.existsSync(originalManifestPath)) {
      fs.renameSync(originalManifestPath, currentManifestPath);
    }
  } catch (rollbackError) {
    error.message += `; rollback also failed: ${rollbackError.message}`;
  }
  if (fs.existsSync(pendingManifestPath)) fs.rmSync(pendingManifestPath, { force: true });
  if (fs.existsSync(stagingDirectory)) fs.rmSync(stagingDirectory, { recursive: true, force: true });
  throw error;
}
