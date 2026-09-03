const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const cache = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'versioning', 'version-tree-snapshot-cache.ts')).href);
  cache.clearVersionTreeSnapshotCacheForTests();

  const folders = [{ id: 'progress-1', displayName: 'V1' }];
  const edges = [{ id: 'edge-1', sourceProgressId: 'source', targetProgressId: 'progress-1' }];
  cache.rememberVersionTreeSnapshot('C:\\Workspace', 'Project', 'C:\\Workspace\\Project', '后期中', folders, edges);

  folders.push({ id: 'caller-only', displayName: 'caller-only' });
  edges.length = 0;
  const first = cache.peekVersionTreeSnapshot('c:/workspace/', 'project', 'c:/workspace/project/', '后期中');
  assert(first, 'a normalized project identity must reuse its trusted session snapshot');
  assert.deepStrictEqual(first.progressFolders.map(item => item.id), ['progress-1'], 'remember must isolate cached arrays from caller mutation');
  assert.deepStrictEqual(first.graphEdges.map(item => item.id), ['edge-1']);

  first.progressFolders.length = 0;
  const second = cache.peekVersionTreeSnapshot('C:\\Workspace', 'Project', 'C:\\Workspace\\Project', '后期中');
  assert.deepStrictEqual(second.progressFolders.map(item => item.id), ['progress-1'], 'peek must not expose the cached array for mutation');
  assert.strictEqual(cache.peekVersionTreeSnapshot('C:\\Workspace', 'Project', 'C:\\Workspace\\Project', '已归档'), undefined, 'status changes must not reuse a stale folder-location snapshot');
  assert.strictEqual(cache.peekVersionTreeSnapshot('C:\\Other', 'Project', 'C:\\Workspace\\Project', '后期中'), undefined, 'workspace identities must remain isolated');

  cache.clearVersionTreeSnapshotCacheForTests();
  assert.strictEqual(cache.peekVersionTreeSnapshot('C:\\Workspace', 'Project', 'C:\\Workspace\\Project', '后期中'), undefined);
  console.log('version-tree snapshot cache tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
