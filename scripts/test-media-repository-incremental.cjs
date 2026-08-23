const assert = require('assert/strict');
const { createMediaRepository, MEDIA_SYNC_BATCH_SIZE } = require('../electron/repositories/media-repository.cjs');

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
  await assert.rejects(createMediaRepository(client).syncChangedPaths('C:/workspace', 'Project', new Array(2049).fill('a.jpg')), /2048/);
  console.log('incremental media repository tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
