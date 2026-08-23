const assert = require('assert/strict');
const { ThumbnailCoordinator } = require('../electron/services/thumbnail-coordinator.cjs');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const run = async () => {
  const order = [];
  const indexerGate = deferred();
  const indexerStarted = deferred();
  const flushed = [];
  const coordinator = new ThumbnailCoordinator({
    touchFlushDelayMs: 1000,
    touchFlusher: async touches => { flushed.push(touches); order.push('touches'); },
  });
  coordinator.touch('C:/source.jpg', 'small');
  coordinator.touch('C:/source.jpg', 'small');
  const indexer = coordinator.withIndexer(async () => {
    order.push('indexer');
    indexerStarted.resolve();
    await indexerGate.promise;
  });
  await indexerStarted.promise;
  const maintenance = coordinator.withMaintenance(async () => { order.push('maintenance'); });
  const publisher = coordinator.withPublisher(async () => { order.push('publisher'); });
  assert.equal(coordinator.status().maintenanceWaiting, 1);
  assert.equal(coordinator.status().queuedReaders, 1, 'publisher arriving behind maintenance must wait');
  indexerGate.resolve();
  await Promise.all([indexer, maintenance, publisher]);
  assert.deepEqual(order, ['indexer', 'touches', 'maintenance', 'publisher']);
  assert.equal(flushed[0].length, 1, 'touches must coalesce and flush before maintenance');
  assert.deepEqual(coordinator.status(), {
    activeReaders: 0, maintenanceActive: false, maintenanceWaiting: 0, queuedReaders: 0, pendingTouches: 0,
  });

  const deadlineCoordinator = new ThumbnailCoordinator();
  const deadlineGate = deferred();
  const active = deadlineCoordinator.withIndexer(() => deadlineGate.promise);
  await assert.rejects(
    deadlineCoordinator.withMaintenance({ deadlineAt: Date.now() + 15 }, async () => undefined),
    error => error.code === 'THUMBNAIL_MAINTENANCE_DEADLINE',
  );
  assert.equal(deadlineCoordinator.status().maintenanceWaiting, 0);
  deadlineGate.resolve();
  await active;

  const cancellationCoordinator = new ThumbnailCoordinator();
  const cancellationGate = deferred();
  const cancellationIndexer = cancellationCoordinator.withIndexer(() => cancellationGate.promise);
  const controller = new AbortController();
  const cancelled = cancellationCoordinator.withMaintenance({ signal: controller.signal }, async () => undefined);
  controller.abort(Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' }));
  await assert.rejects(cancelled, error => error.code === 'TASK_CANCELLED');
  cancellationGate.resolve();
  await cancellationIndexer;

  const yieldingCoordinator = new ThumbnailCoordinator();
  let foregroundCompleted = false;
  let maintenanceCompletedAt = 0;
  const yieldingMaintenance = yieldingCoordinator.withMaintenance(async () => {
    for (let batch = 0; batch < 4; batch += 1) {
      await new Promise(resolve => setTimeout(resolve, 40));
      await yieldingCoordinator.yieldToReaders({ deadlineAt: Date.now() + 1000 });
    }
    maintenanceCompletedAt = Date.now();
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const boundedForeground = yieldingCoordinator.withPublisher(async () => {
    foregroundCompleted = true;
  });
  await boundedForeground;
  assert.equal(foregroundCompleted, true);
  assert.equal(maintenanceCompletedAt, 0, 'foreground work must complete before the multi-batch maintenance turn finishes');
  await yieldingMaintenance;
  console.log('thumbnail coordinator tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
