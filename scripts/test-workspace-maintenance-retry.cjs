const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { runWorkspaceMaintenanceWithRetry, workspaceDatabaseTaskResource } = require('../electron/modules/workspace-ipc.cjs');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const mediaTrackingSchedulerSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'media-tracking-scan-scheduler.cjs'), 'utf8');
const dirtyRunnerSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'dirty-coalescing-runner.cjs'), 'utf8');
const scheduledScanStart = mainSource.indexOf('const scheduleMediaTrackingScan');
const scheduledScanBlock = mainSource.slice(scheduledScanStart, mainSource.indexOf('const cancelMediaTrackingScan', scheduledScanStart));
assert(scheduledScanBlock.includes('mediaTrackingScanScheduler?.schedule') && mainSource.includes('mediaTrackingScanScheduler?.cancel'), 'main must delegate automatic media scan lifecycle to the isolated scheduler');
assert(mediaTrackingSchedulerSource.includes('backgroundTasks.run({') && mediaTrackingSchedulerSource.includes('photoflow-workspace-database/'), 'automatic media scans must reserve the shared workspace database writer');
assert(mediaTrackingSchedulerSource.includes('createDirtyCoalescingRunner') && dirtyRunnerSource.includes('state.pendingBatch = merge(state.inFlightBatch, state.pendingBatch)') && dirtyRunnerSource.includes('state.completedGeneration'), 'automatic media scans must use the shared failure-safe dirty runner');

const run = async () => {
  let attempts = 0;
  const waits = [];
  const reports = [];
  const result = await runWorkspaceMaintenanceWithRetry({
    root: 'D:/workspace',
    repository: {
      runMaintenance: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('localized busy message'), { code: 'SQLITE_BUSY' });
        return { success: true };
      },
    },
    task: { report: (...args) => reports.push(args) },
    wait: async delay => { waits.push(delay); },
    retryDelays: [10, 20, 40],
  });
  assert.deepEqual(result, { success: true });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.match(reports[0][1], /自动重试/);
  assert.deepEqual(workspaceDatabaseTaskResource('D:/workspace'), {
    path: 'photoflow-workspace-database/D:/workspace',
    access: 'write',
  });

  let nonLockAttempts = 0;
  await assert.rejects(runWorkspaceMaintenanceWithRetry({
    root: 'D:/workspace',
    repository: { runMaintenance: async () => { nonLockAttempts += 1; throw new Error('database disk image is malformed'); } },
    wait: async () => { throw new Error('non-lock errors must not wait'); },
    retryDelays: [1, 2],
  }), /malformed/);
  assert.equal(nonLockAttempts, 1, 'non-lock failures must surface immediately');

  console.log('workspace maintenance retry tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
