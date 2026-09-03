const assert = require('assert/strict');
const { createMediaRepository, MEDIA_SYNC_BATCH_SIZE } = require('../electron/repositories/media-repository.cjs');
const { MAX_CHANGED_PATHS } = require('../electron/contracts/media-sync-limits.cjs');

(async () => {
  const calls = [];
  const files = Array.from({ length: 1537 }, (_, index) => ({ filePath: `C:/workspace/Project/${index}.jpg` }));
  const client = {
    call: async (_root, action, payload) => {
      calls.push({ action, payload });
      if (action === 'media_sync_paths_prepare') return {
        snapshotId: '11111111-1111-1111-1111-111111111111', files,
        scopes: [{ pathKey: 'c:/workspace/project', kind: 'directory' }], baselineVersions: [],
        authorizedRoots: [{ path: 'C:/workspace/Project', kind: 'folder' }],
      };
      if (action === 'media_sync_paths_apply_batch') return { count: payload.files.length };
      if (action === 'media_sync_paths_finalize') return { missingCount: 0, thumbnailCandidates: [] };
      throw new Error(`unexpected full sync action: ${action}`);
    },
    stop: () => undefined,
  };
  const result = await createMediaRepository(client).syncChangedPaths('C:/workspace', 'Project', [{ path: 'C:/workspace/Project', eventType: 'rename', kind: 'directory' }]);
  const batches = calls.filter(call => call.action === 'media_sync_paths_apply_batch');
  assert.equal(batches.length, Math.ceil(1537 / MEDIA_SYNC_BATCH_SIZE), 'large subtrees must use bounded database batches');
  assert(batches.every(call => call.payload.files.length <= MEDIA_SYNC_BATCH_SIZE));
  assert.equal(result.count, 1537);
  assert.equal(calls.some(call => call.action === 'media_sync_prepare'), false, 'incremental sync must never call full-project prepare');
  await assert.rejects(createMediaRepository(client).syncChangedPaths('C:/workspace', 'Project', new Array(MAX_CHANGED_PATHS + 1).fill('a.jpg')), new RegExp(String(MAX_CHANGED_PATHS)));

  const fullCalls = [];
  const fullFiles = Array.from({ length: 1537 }, (_, index) => ({ filePath: `C:/workspace/Project/full-${index}.jpg` }));
  const fullClient = {
    call: async (_root, action, payload) => {
      fullCalls.push({ action, payload });
      if (action === 'media_sync_prepare') {
        const offset = Number(payload.pageToken || 0);
        const page = fullFiles.slice(offset, offset + MEDIA_SYNC_BATCH_SIZE);
        return {
          paged: true, snapshotId: payload.snapshotId, pageOffset: offset,
          files: page, nextPageToken: offset + page.length < fullFiles.length ? String(offset + page.length) : null,
        };
      }
      if (action === 'media_sync_paths_apply_batch') return { count: payload.files.length };
      if (action === 'media_sync_paths_finalize') return { missingCount: 0, thumbnailCandidates: [] };
      throw new Error(`unexpected action: ${action}`);
    },
    stop: () => undefined,
  };
  const fullResult = await createMediaRepository(fullClient).syncProject('C:/workspace', 'Project');
  const fullPages = fullCalls.filter(call => call.action === 'media_sync_prepare');
  const fullBatches = fullCalls.filter(call => call.action === 'media_sync_paths_apply_batch');
  assert(fullPages.length > 1, 'full sync must pull a persisted manifest page-by-page');
  assert(fullPages.every(call => call.payload.paged === true && call.payload.pageSize === MEDIA_SYNC_BATCH_SIZE));
  assert(fullBatches.every(call => call.payload.files.length <= MEDIA_SYNC_BATCH_SIZE));
  assert.equal(Math.max(...fullBatches.map(call => call.payload.files.length)), MEDIA_SYNC_BATCH_SIZE);
  assert.equal(fullResult.count, fullFiles.length);

  const cancellationController = new AbortController();
  let cancellationBatches = 0;
  const cancellableRepository = createMediaRepository({
    call: async (_root, action, payload) => {
      if (action === 'media_sync_paths_prepare') return { snapshotId: '22222222-2222-4222-8222-222222222222', files };
      if (action === 'media_sync_paths_apply_batch') {
        cancellationBatches += 1;
        cancellationController.abort();
        return { count: payload.files.length };
      }
      if (action === 'media_sync_paths_finalize') throw new Error('cancelled media sync must not finalize');
      throw new Error(`unexpected cancellable sync action: ${action}`);
    },
  });
  await assert.rejects(
    cancellableRepository.syncChangedPaths('C:/workspace', 'Project', [{ path: 'C:/workspace/Project', eventType: 'rename', kind: 'directory' }], [], { signal: cancellationController.signal }),
    error => error?.code === 'TASK_CANCELLED',
  );
  assert.equal(cancellationBatches, 1, 'a foreground mutation must stop an index at the next 64-file batch boundary');

  const preemptionCalls = [];
  const preemptibleRepository = createMediaRepository({
    call: async (_root, action, payload, _timeout, options) => {
      preemptionCalls.push({ action, payload, options });
      if (action === 'media_sync_prepare') throw Object.assign(new Error('foreground entered'), { code: 'DATABASE_PREEMPTED' });
      if (action === 'media_sync_abort') return { success: true, removed: true };
      throw new Error(`unexpected preemption action: ${action}`);
    },
  });
  await assert.rejects(
    preemptibleRepository.syncProject('C:/workspace', 'Project', [], { background: true }),
    error => error?.code === 'DATABASE_PREEMPTED',
  );
  assert.deepEqual(preemptionCalls.map(call => call.action), ['media_sync_prepare', 'media_sync_abort']);
  assert.equal(preemptionCalls[0].options.preemptible, true);
  assert.equal(preemptionCalls[0].options.priority, -10);
  console.log('incremental media repository tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
