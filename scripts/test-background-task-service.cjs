const assert = require('assert');
const { EventEmitter } = require('events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const fs = require('fs');
const path = require('path');
const projectFileTaskSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'project-file-task-service.cjs'), 'utf8');
assert(projectFileTaskSource.includes("scanning: '正在统计'") && projectFileTaskSource.includes("concurrencyLimit = 2"), 'file tasks must show scanning immediately without raising the existing disk concurrency limit');

const queued = async promise => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
};

const main = async () => {
  const service = createBackgroundTaskService({ eventBus: new EventEmitter() });
  const definition = (id, resource, limit = 2) => ({
    id,
    type: 'test',
    title: id,
    resources: [resource],
    concurrencyGroup: 'disk-io',
    concurrencyLimit: limit,
  });

  const first = service.create(definition('first', 'C:/projects/a'));
  const second = service.create(definition('second', 'C:/projects/b'));
  const third = service.create(definition('third', 'C:/projects/c'));
  await Promise.all([first.waitForStart(), second.waitForStart()]);
  assert.equal(service.get('first').state, 'running', 'independent disk tasks must keep running concurrently');
  assert.equal(service.get('second').state, 'running', 'the existing concurrency limit must allow the second independent task');
  const thirdStart = third.waitForStart();
  assert.equal(await queued(thirdStart), true, '第三个磁盘任务应等待并发名额');
  assert.equal(service.get('third').state, 'queued', 'tasks beyond the existing concurrency limit must remain queued');
  first.complete();
  await thirdStart;
  second.complete();
  third.complete();

  const parent = service.create(definition('parent', 'C:/projects/shared', 2));
  const child = service.create(definition('child', 'c:\\projects\\shared\\subfolder', 2));
  await parent.waitForStart();
  const childStart = child.waitForStart();
  assert.equal(await queued(childStart), true, '父子路径重叠的任务应自动排队');
  assert.equal(service.get('child').state, 'queued', 'path-conflicting tasks must remain queued without changing the concurrency limit');
  parent.complete();
  await childStart;
  child.complete();

  const blocker = service.create(definition('blocker', 'C:/projects/x', 1));
  const cancelled = service.create(definition('cancelled', 'C:/projects/y', 1));
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
