const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeActionableWatchChanges, filterActionableWatchEntries, isMediaRelevantChange, isNonContentMetadataChange } = require('../electron/services/watch-change-filter.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-watch-change-filter-'));
try {
  const directory = path.join(root, 'Project', 'folder');
  const oldFile = path.join(root, 'Project', 'old.jpg');
  const freshFile = path.join(root, 'Project', 'fresh.jpg');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(freshFile, 'fresh');
  const now = Date.now();
  const oldTime = new Date(now - 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, oldTime, oldTime);

  const oldStat = fs.statSync(oldFile);
  const oldSnapshot = { kind: 'file', size: oldStat.size, mtimeMs: oldStat.mtimeMs, ctimeMs: oldStat.ctimeMs };
  assert.equal(isNonContentMetadataChange(root, path.relative(root, directory), { eventType: 'change', previous: { kind: 'directory' } }, fs), true, 'unchanged directory metadata must not trigger recursive media work');
  assert.equal(isNonContentMetadataChange(root, path.relative(root, oldFile), { eventType: 'change', previous: oldSnapshot }, fs), true, 'an unchanged old file must not masquerade as a content edit');
  fs.writeFileSync(oldFile, 'new');
  fs.utimesSync(oldFile, oldTime, oldTime);
  assert.equal(isNonContentMetadataChange(root, path.relative(root, oldFile), { eventType: 'change', previous: oldSnapshot }, fs), false, 'a real write that preserves an old mtime must remain actionable');
  assert.equal(isNonContentMetadataChange(root, path.relative(root, freshFile), 'change', fs), false, 'a change without known state must remain actionable');
  assert.equal(isNonContentMetadataChange(root, path.relative(root, oldFile), 'rename', fs, now), false, 'rename/create/delete events must remain actionable regardless of mtime');
  assert.equal(isNonContentMetadataChange(root, path.join('Project', 'missing.jpg'), 'change', fs, now), false, 'a disappeared path must remain actionable for missing-file reconciliation');

  const actionable = filterActionableWatchEntries(root, [
    [path.relative(root, directory), { eventType: 'change', previous: { kind: 'directory' } }],
    [path.relative(root, oldFile), { eventType: 'change', previous: oldSnapshot }],
    [path.relative(root, freshFile), 'change'],
    [path.relative(root, oldFile), 'rename'],
    [path.join('Project', 'missing.jpg'), 'change'],
  ], fs);
  assert.deepEqual(actionable, [
    [path.relative(root, oldFile), { eventType: 'change', previous: oldSnapshot }],
    [path.relative(root, freshFile), 'change'],
    [path.relative(root, oldFile), 'rename'],
    [path.join('Project', 'missing.jpg'), 'change'],
  ]);
  const described = describeActionableWatchChanges(root, actionable, fs, now);
  assert.equal(described[0].kind, 'file');
  assert.equal(described[0].eventType, 'change');
  assert.equal(described[1].observedSize, 5);
  assert.equal(described[3].kind, 'missing');
  assert.equal(isMediaRelevantChange({ path: path.join(root, 'notes.txt'), kind: 'file' }), false, 'ordinary files must not trigger media sync');
  assert.equal(isMediaRelevantChange({ path: path.join(root, 'notes.txt'), kind: 'missing', previousKind: 'file', previousExtension: '.txt' }), false, 'deleting notes.txt must produce zero media work');
  assert.equal(isMediaRelevantChange({ path: path.join(root, 'removed.jpg'), kind: 'missing', previousKind: 'file', previousExtension: '.jpg' }), true);
  assert.equal(isMediaRelevantChange({ path: path.join(root, 'removed-folder'), kind: 'missing', previousKind: 'directory' }), true);
  assert.equal(isMediaRelevantChange({ path: path.join(root, 'unknown-entry'), kind: 'missing' }), true, 'a first-seen deletion with unknown shape must reconcile conservatively');
  assert.equal(isMediaRelevantChange({ path: path.join(root, 'unknown.folder'), kind: 'missing', previousExtension: '.folder' }), true, 'an unknown deleted directory must not be inferred to be a non-media file from its name');
  assert.equal(isMediaRelevantChange({ path: path.join(root, 'extensionless'), kind: 'missing', knownMedia: true }), true, 'database-known media paths remain actionable without an extension');
  assert.equal(isMediaRelevantChange({ path: freshFile, kind: 'file' }), true);
  console.log('watch change filter tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (!process.env.PHOTOFLOW_WATCH_TEST_CHILD) {
  const { spawnSync } = require('child_process');
  for (const testFile of [
    'test-watch-file-root-watcher-service.cjs',
    'test-watch-managed-external-watcher.cjs',
    'test-workspace-reconcile-task.cjs',
  ]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, testFile)], {
      stdio: 'inherit',
      env: { ...process.env, PHOTOFLOW_WATCH_TEST_CHILD: '1' },
    });
    assert.equal(result.status, 0, `${testFile} failed`);
  }
}
