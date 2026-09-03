const assert = require('assert/strict');
const { createMediaRepository, MEDIA_SYNC_BATCH_SIZE } = require('../electron/repositories/media-repository.cjs');
const { WorkspaceDatabaseOperationPolicy } = require('../electron/repositories/workspace-database-operation-policy.cjs');

const run = async () => {
  const calls = [];
  let interactiveRan = false;
  const files = Array.from({ length: MEDIA_SYNC_BATCH_SIZE * 2 + 1 }, (_, index) => ({ filePath: `C:/Project/${index}.jpg` }));
  const client = {
    call: async (_root, action, payload) => {
      calls.push({ action, payload });
      if (action === 'media_sync_prepare') return {
        success: true, snapshotId: '11111111-1111-1111-1111-111111111111', files,
        authorizedRoots: [{ path: 'C:/Project', kind: 'folder' }], baselineVersions: [],
      };
      if (action === 'media_sync_apply_batch') {
        if (payload.batchIndex === 0) setImmediate(() => { interactiveRan = true; });
        return { success: true, count: payload.files.length };
      }
      if (action === 'media_sync_finalize') return { success: true, thumbnailCandidates: [] };
      throw new Error(`unexpected action: ${action}`);
    },
    stop: () => undefined,
  };
  const repository = createMediaRepository(client);
  const result = await repository.syncProject('C:/Workspace', 'Project');
  assert.equal(result.count, files.length);
  assert.deepEqual(calls.map(call => call.action), [
    'media_sync_prepare', 'media_sync_apply_batch', 'media_sync_apply_batch', 'media_sync_apply_batch', 'media_sync_finalize',
  ]);
  assert(calls.filter(call => call.action === 'media_sync_apply_batch').every(call => call.payload.files.length <= MEDIA_SYNC_BATCH_SIZE));
  assert.equal(interactiveRan, true, 'repository must yield after releasing each writer batch');

  let prepareCount = 0;
  const staleCalls = [];
  const staleRepository = createMediaRepository({
    call: async (_root, action, payload) => {
      staleCalls.push(action);
      if (action === 'progress_stale_prepare') {
        prepareCount += 1;
        return prepareCount === 1
          ? { success: true, snapshotId: '22222222-2222-2222-2222-222222222222', revision: 'old', candidates: [{ id: 'p1' }], scannedProgressIds: ['p1'], propagatedProgressIds: [] }
          : { success: true, snapshotId: '33333333-3333-3333-3333-333333333333', revision: 'new', candidates: [], scannedProgressIds: ['p1'], staleProgressIds: [], propagatedProgressIds: [] };
      }
      if (action === 'progress_stale_apply') {
        assert.equal(payload.revision, 'old');
        return { success: true, revisionExpired: true };
      }
      throw new Error(`unexpected action: ${action}`);
    },
    stop: () => undefined,
  });
  const stale = await staleRepository.detectProgressStale('C:/Workspace', { projectName: 'Project', changedPaths: [] });
  assert.deepEqual(stale.staleProgressIds, []);
  assert.deepEqual(staleCalls, ['progress_stale_prepare', 'progress_stale_apply', 'progress_stale_prepare']);

  const policy = new WorkspaceDatabaseOperationPolicy();
  assert.equal(policy.classify({ database: 'C:/db.sqlite3', action: 'media_sync_prepare' }).mode, 'write', 'domain attachment still updates schema metadata, so prepare must retain the writer lease');
  assert.equal(policy.classify({ database: 'C:/db.sqlite3', action: 'media_sync_apply_batch' }).mode, 'exclusive', 'staged media publication must exclude readers only for its short publish batch');
  assert.equal(policy.classify({ database: 'C:/db.sqlite3', action: 'progress_stale_prepare' }).mode, 'read', 'query-only stale preparation must not block foreground version-tree writers during a long filesystem scan');
  assert.equal(policy.classify({ database: 'C:/db.sqlite3', action: 'progress_stale_apply' }).idempotent, true);

  const foregroundCalls = [];
  const foregroundRepository = createMediaRepository({
    call: async (...args) => { foregroundCalls.push(args); return { success: true, revision: 0, positions: [], progressFolders: [], graphEdges: [] }; },
  });
  await foregroundRepository.snapshotProgress('C:/Workspace', 'Project', true);
  await foregroundRepository.getVersionTreeLayout('C:/Workspace', { projectName: 'Project', scopeKey: '' });
  assert(foregroundCalls.every(call => call[4]?.priority === 10), 'progress and layout snapshots must enter the database coordinator at foreground priority');
  console.log('media sync batching tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
