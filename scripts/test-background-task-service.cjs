const assert = require('assert');
const { EventEmitter } = require('events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const fs = require('fs');
const path = require('path');
const projectFileTaskSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'project-file-task-service.cjs'), 'utf8');
const versionsIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'versions-ipc.cjs'), 'utf8');
assert(projectFileTaskSource.includes("scanning: '正在统计'") && projectFileTaskSource.includes('concurrencyLimit = 3') && projectFileTaskSource.includes('concurrencyWriteLimit = 2'), 'file tasks must allow three total disk tasks while retaining the two-writer limit');
const deferredMediaScanStart = versionsIpcSource.indexOf("type: 'version-media-rescan'");
const deferredMediaScanBlock = versionsIpcSource.slice(deferredMediaScanStart, versionsIpcSource.indexOf('const updatedFolderPath', deferredMediaScanStart));
assert(deferredMediaScanBlock.includes("resourceAccess: 'read'") && deferredMediaScanBlock.includes('resources: [projectPath]'), 'deferred media maintenance must declare its project path as read-only');
assert(deferredMediaScanBlock.includes("task.report(5, '正在扫描项目媒体文件')"), 'deferred media maintenance must leave 0% immediately after it starts');

const queued = async promise => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
};

const main = async () => {
  const service = createBackgroundTaskService({ eventBus: new EventEmitter() });
  const monotonic = service.create({ id: 'monotonic', type: 'test', title: 'monotonic', concurrencyGroup: 'progress', concurrencyLimit: 1 });
  await monotonic.waitForStart();
  monotonic.context.report(60, 'phase one');
  monotonic.context.report(40, 'phase two');
  assert.equal(service.get('monotonic').progress, 60, 'background task progress must never move backwards between phases');
  monotonic.complete();
  const definition = (id, resource, { limit = 3, writeLimit = 2, access = 'write' } = {}) => ({
    id,
    type: 'test',
    title: id,
    resources: [resource],
    concurrencyGroup: 'disk-io',
    concurrencyLimit: limit,
    concurrencyWriteLimit: writeLimit,
    resourceAccess: access,
  });

  const first = service.create(definition('first', 'C:/projects/a'));
  const second = service.create(definition('second', 'C:/projects/b'));
  const third = service.create(definition('third', 'C:/projects/c'));
  await Promise.all([first.waitForStart(), second.waitForStart()]);
  assert.equal(service.get('first').state, 'running', 'independent disk tasks must keep running concurrently');
  assert.equal(service.get('second').state, 'running', 'the two-writer limit must allow the second independent write');
  const thirdStart = third.waitForStart();
  assert.equal(await queued(thirdStart), true, '第三个磁盘写入任务应等待写入名额');
  assert.equal(service.get('third').state, 'queued', 'a third writer must remain queued');
  const readThird = service.create(definition('read-third', 'C:/projects/d', { access: 'read' }));
  await readThird.waitForStart();
  assert.equal(service.get('read-third').state, 'running', 'a read task must be allowed to use the third disk slot');
  const readFourth = service.create(definition('read-fourth', 'C:/projects/e', { access: 'read' }));
  const readFourthStart = readFourth.waitForStart();
  assert.equal(await queued(readFourthStart), true, '第四个磁盘任务应等待总并发名额');
  readThird.complete();
  await readFourthStart;
  readFourth.complete();
  first.complete();
  await thirdStart;
  second.complete();
  third.complete();

  const parent = service.create(definition('parent', 'C:/projects/shared'));
  const child = service.create(definition('child', 'c:\\projects\\shared\\subfolder'));
  await parent.waitForStart();
  const childStart = child.waitForStart();
  assert.equal(await queued(childStart), true, '父子路径重叠的任务应自动排队');
  assert.equal(service.get('child').state, 'queued', 'path-conflicting tasks must remain queued without changing the concurrency limit');
  parent.complete();
  await childStart;
  child.complete();

  const maintenance = service.create(definition('maintenance-scan', 'C:/projects/shared', { access: 'read' }));
  const focusedCompare = service.create(definition('focused-compare', 'C:/projects/shared/version-2', { access: 'read' }));
  await Promise.all([maintenance.waitForStart(), focusedCompare.waitForStart()]);
  assert.equal(service.get('focused-compare').state, 'running', 'overlapping read tasks must run concurrently');
  const overlappingWrite = service.create(definition('overlapping-write', 'C:/projects/shared/version-2/output'));
  const overlappingWriteStart = overlappingWrite.waitForStart();
  assert.equal(await queued(overlappingWriteStart), true, 'a write overlapping active reads must wait');
  maintenance.complete();
  focusedCompare.complete();
  await overlappingWriteStart;
  overlappingWrite.complete();

  const blocker = service.create(definition('blocker', 'C:/projects/x', { limit: 1, writeLimit: 1 }));
  const cancelled = service.create(definition('cancelled', 'C:/projects/y', { limit: 1, writeLimit: 1 }));
  await blocker.waitForStart();
  const cancelledStart = cancelled.waitForStart();
  assert.equal(service.cancel('cancelled'), true);
  await assert.rejects(cancelledStart, error => error?.code === 'TASK_CANCELLED');
  cancelled.cancelled();
  assert.equal(service.get('cancelled').state, 'cancelled');
  assert.equal(service.dismiss('cancelled'), true);
  assert.equal(service.get('cancelled'), null);
  blocker.complete();

  console.log('background task scheduler tests passed');
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
