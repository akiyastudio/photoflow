import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduleWorkflowWeeks } from '../src/utils/teamWorkflow.ts';
import workflowGeneration from '../electron/services/team-workflow-generation.cjs';

const { buildWorkflowPlan, copyWorkflowPlan } = workflowGeneration;

const entry = (taskId, identityId, personIndex) => ({
  key: `${taskId}:${identityId}`,
  taskId,
  personIndex,
  identityId,
  identityName: identityId,
});

const identityWeekCounts = (entries, schedule) => {
  const result = new Map();
  for (const item of entries) {
    const weeks = result.get(item.identityId) || new Set();
    weeks.add(schedule.get(item.key));
    result.set(item.identityId, weeks);
  }
  return result;
};

const assertTaskWeeksAreUnique = (entries, schedule) => {
  const tasks = new Map();
  for (const item of entries) {
    const weeks = tasks.get(item.taskId) || [];
    weeks.push(schedule.get(item.key));
    tasks.set(item.taskId, weeks);
  }
  for (const weeks of tasks.values()) assert.equal(new Set(weeks).size, weeks.length);
};

const assertPreferredOrder = (entries, schedule, preferredIdentityOrder) => {
  const preferenceRank = new Map(preferredIdentityOrder.map((identityId, index) => [identityId, index]));
  const tasks = new Map();
  for (const item of entries) {
    const members = tasks.get(item.taskId) || [];
    members.push(item);
    tasks.set(item.taskId, members);
  }
  for (const members of tasks.values()) {
    const preferredMembers = members.filter(item => preferenceRank.has(item.identityId)).sort((left, right) => preferenceRank.get(left.identityId) - preferenceRank.get(right.identityId));
    for (let index = 1; index < preferredMembers.length; index += 1) {
      assert.ok(schedule.get(preferredMembers[index - 1].key) < schedule.get(preferredMembers[index].key));
    }
  }
};

// This chain is two-colourable. Every person can therefore receive all of
// their work in one week without increasing the two-week project duration.
const chain = [
  entry('A', '1', 1), entry('A', '2', 2),
  entry('B', '2', 1), entry('B', '3', 2),
  entry('C', '3', 1), entry('C', '4', 2),
];
const chainSchedule = scheduleWorkflowWeeks(chain);
assertTaskWeeksAreUnique(chain, chainSchedule);
assert.equal(Math.max(...chainSchedule.values()), 2);
for (const weeks of identityWeekCounts(chain, chainSchedule).values()) assert.equal(weeks.size, 1);

// An odd conflict cycle cannot put every person in a single week while still
// finishing in two weeks. The optimum is exactly one fragmented identity.
const triangle = [
  entry('A', '1', 1), entry('A', '2', 2),
  entry('B', '2', 1), entry('B', '3', 2),
  entry('C', '1', 1), entry('C', '3', 2),
];
const triangleSchedule = scheduleWorkflowWeeks(triangle);
assertTaskWeeksAreUnique(triangle, triangleSchedule);
assert.equal(Math.max(...triangleSchedule.values()), 2);
assert.equal([...identityWeekCounts(triangle, triangleSchedule).values()].filter(weeks => weeks.size > 1).length, 1);

// Equal inputs must never jump between equivalent schedules.
assert.deepEqual([...scheduleWorkflowWeeks(triangle)], [...triangleSchedule]);

// A manually selected starter is a hard constraint: every occurrence of that
// identity starts in week one while unrelated tasks can still run in parallel.
const preferredSchedule = scheduleWorkflowWeeks(triangle, { preferredIdentityId: '3' });
assertTaskWeeksAreUnique(triangle, preferredSchedule);
for (const item of triangle.filter(candidate => candidate.identityId === '3')) {
  assert.equal(preferredSchedule.get(item.key), 1);
}

// A stale preference must behave like automatic scheduling instead of
// producing an invalid or partially constrained result.
assert.deepEqual([...scheduleWorkflowWeeks(triangle, { preferredIdentityId: 'missing' })], [...triangleSchedule]);

// Multiple manually ordered identities keep their relative order whenever
// they share a task. The first queued identity remains the absolute starter.
const orderedSchedule = scheduleWorkflowWeeks(triangle, { preferredIdentityOrder: ['1', '2', '3'] });
assertTaskWeeksAreUnique(triangle, orderedSchedule);
assertPreferredOrder(triangle, orderedSchedule, ['1', '2', '3']);
for (const item of triangle.filter(candidate => candidate.identityId === '1')) assert.equal(orderedSchedule.get(item.key), 1);

// Dragging the same people into the reverse order must reverse every shared
// task relation instead of merely reordering cards in the interface.
const reversedSchedule = scheduleWorkflowWeeks(triangle, { preferredIdentityOrder: ['3', '2', '1'] });
assertTaskWeeksAreUnique(triangle, reversedSchedule);
assertPreferredOrder(triangle, reversedSchedule, ['3', '2', '1']);
for (const item of triangle.filter(candidate => candidate.identityId === '3')) assert.equal(reversedSchedule.get(item.key), 1);

// The preferred starter must still use week one in a smaller task even when
// another task makes additional global week columns available.
const uneven = [
  entry('wide', '1', 1), entry('wide', '2', 2), entry('wide', '3', 3),
  entry('small', '4', 1), entry('small', '5', 2),
];
const unevenSchedule = scheduleWorkflowWeeks(uneven, { preferredIdentityOrder: ['4', '5'] });
assertTaskWeeksAreUnique(uneven, unevenSchedule);
assertPreferredOrder(uneven, unevenSchedule, ['4', '5']);
assert.equal(unevenSchedule.get('small:4'), 1);

// Workflow generation must resolve every source from the one project snapshot
// and copy with bounded concurrency. A second run reuses completed files.
const workflowRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-team-workflow-'));
try {
  const sourceDirectory = path.join(workflowRoot, 'sources');
  const stagingDirectory = path.join(workflowRoot, 'staging');
  await fs.promises.mkdir(sourceDirectory, { recursive: true });
  const sources = await Promise.all([1, 2, 3, 4].map(async index => {
    const sourcePath = path.join(sourceDirectory, `${index}.png`);
    await fs.promises.writeFile(sourcePath, Buffer.alloc(1024 * index, index));
    return sourcePath;
  }));
  const workspace = {
    photos: [{
      photoId: 'photo',
      baseVersionId: 'base',
      tasks: sources.map((sourcePath, index) => ({ id: `task-${index + 1}`, baseVersionId: 'base', personIndex: index + 1, members: [{ personIndex: index + 1 }], patchPath: sourcePath })),
    }],
  };
  const groups = [{
    week: 1,
    identityId: 'identity',
    identityName: '测试人物',
    items: sources.map((_, index) => ({ photoId: 'photo', baseVersionId: 'base', taskId: `task-${index + 1}`, personIndex: index + 1, photoName: '同名图片' })),
  }];
  const plan = await buildWorkflowPlan({
    groups,
    workspace,
    stagingDirectory,
    safeSegment: value => value,
    weekName: week => `第${week}周`,
  });
  assert.equal(plan.files.length, 4);
  assert.equal(plan.totalBytes, 1024 * 10);
  assert.equal(new Set(plan.files.map(file => file.destination)).size, 4);
  assert.ok(plan.manifestGroups[0].items.every(item => item.relativePath.startsWith('第1周/测试人物/')));

  let activeCopies = 0;
  let maximumCopies = 0;
  let copyCount = 0;
  const copyFileAtomic = async (source, destination, options) => {
    activeCopies += 1;
    maximumCopies = Math.max(maximumCopies, activeCopies);
    copyCount += 1;
    try {
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await new Promise(resolve => setTimeout(resolve, 15));
      await fs.promises.copyFile(source, destination);
      const sourceStat = await fs.promises.stat(source);
      await fs.promises.utimes(destination, sourceStat.atime, sourceStat.mtime);
      options.onProgress({ bytesCopied: sourceStat.size, totalBytes: sourceStat.size });
    } finally {
      activeCopies -= 1;
    }
  };
  const progress = [];
  await copyWorkflowPlan({ files: plan.files, totalBytes: plan.totalBytes, copyFileAtomic, concurrency: 3, onProgress: value => progress.push(value) });
  assert.equal(copyCount, 4);
  assert.equal(maximumCopies, 3);
  assert.equal(progress.at(-1).completedFiles, 4);
  assert.equal(progress.at(-1).copiedBytes, plan.totalBytes);

  copyCount = 0;
  const resumedProgress = [];
  await copyWorkflowPlan({ files: plan.files, totalBytes: plan.totalBytes, copyFileAtomic, concurrency: 3, onProgress: value => resumedProgress.push(value) });
  assert.equal(copyCount, 0);
  assert.equal(resumedProgress.at(-1).completedFiles, 4);
  await assert.rejects(
    copyWorkflowPlan({ files: plan.files, totalBytes: plan.totalBytes, copyFileAtomic, isCancelled: () => true }),
    error => error?.code === 'EOPCANCELLED',
  );
} finally {
  await fs.promises.rm(workflowRoot, { recursive: true, force: true });
}

console.log('Team workflow scheduling and generation tests passed.');
