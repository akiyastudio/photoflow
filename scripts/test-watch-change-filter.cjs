const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { filterActionableWatchEntries, isNonContentMetadataChange } = require('../electron/services/watch-change-filter.cjs');

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

  assert.equal(isNonContentMetadataChange(root, path.relative(root, directory), 'change', fs, now), true, 'directory attribute changes must not trigger recursive media work');
  assert.equal(isNonContentMetadataChange(root, path.relative(root, oldFile), 'change', fs, now), true, 'old-file access or attribute notifications must not masquerade as content edits');
  assert.equal(isNonContentMetadataChange(root, path.relative(root, freshFile), 'change', fs, now), false, 'a genuinely recent file edit must remain actionable');
  assert.equal(isNonContentMetadataChange(root, path.relative(root, oldFile), 'rename', fs, now), false, 'rename/create/delete events must remain actionable regardless of mtime');
  assert.equal(isNonContentMetadataChange(root, path.join('Project', 'missing.jpg'), 'change', fs, now), false, 'a disappeared path must remain actionable for missing-file reconciliation');

  const actionable = filterActionableWatchEntries(root, [
    [path.relative(root, directory), 'change'],
    [path.relative(root, oldFile), 'change'],
    [path.relative(root, freshFile), 'change'],
    [path.relative(root, oldFile), 'rename'],
    [path.join('Project', 'missing.jpg'), 'change'],
  ], fs, now);
  assert.deepEqual(actionable, [
    [path.relative(root, freshFile), 'change'],
    [path.relative(root, oldFile), 'rename'],
    [path.join('Project', 'missing.jpg'), 'change'],
  ]);
  console.log('watch change filter tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
