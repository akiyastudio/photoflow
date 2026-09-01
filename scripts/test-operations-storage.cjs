const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const python = fs.existsSync(path.join(root, '.venv', 'Scripts', 'python.exe'))
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : 'python';

const run = (script, action, args) => {
  const result = spawnSync(python, [path.join(root, 'python', script), action, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
};

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-operations-storage-'));
try {
  const workspace = path.join(temporary, 'workspace');
  const legacyDatabase = path.join(temporary, 'workspace.sqlite3');
  const operationsDatabase = path.join(temporary, 'domains', 'operations.sqlite3');
  const snapshot = path.join(temporary, 'snapshots', 'operations.sqlite3');
  fs.mkdirSync(workspace);

  run('workspace_db.py', 'init', ['--root', workspace, '--database', legacyDatabase]);
  run('workspace_db.py', 'undo_record_add', [
    '--root', workspace,
    '--database', legacyDatabase,
    '--payload', JSON.stringify({ id: 'legacy-undo', kind: 'trash', payload: { items: [{ original: 'legacy.jpg' }] } }),
  ]);

  const migration = run('operations_db.py', 'init', [
    '--database', operationsDatabase,
    '--payload', JSON.stringify({ legacyDatabase }),
  ]);
  assert.strictEqual(migration.schemaVersion, 1);
  assert.strictEqual(migration.imported, 1, 'legacy undo records must migrate once');
  assert.strictEqual(run('operations_db.py', 'undo_record_latest', [
    '--database', operationsDatabase,
    '--payload', JSON.stringify({ legacyDatabase }),
  ]).record.id, 'legacy-undo');

  run('operations_db.py', 'undo_record_remove', [
    '--database', operationsDatabase,
    '--payload', JSON.stringify({ id: 'legacy-undo', legacyDatabase }),
  ]);
  assert.strictEqual(run('operations_db.py', 'undo_record_latest', [
    '--database', operationsDatabase,
    '--payload', JSON.stringify({ legacyDatabase }),
  ]).record, null, 'removed records must not be imported from the legacy database again');

  run('operations_db.py', 'undo_record_add', [
    '--database', operationsDatabase,
    '--payload', JSON.stringify({ id: 'owned-undo', kind: 'trash', payload: { items: [{ original: 'owned.jpg' }] }, legacyDatabase }),
  ]);
  const records = run('operations_db.py', 'undo_record_list', [
    '--database', operationsDatabase,
    '--payload', JSON.stringify({ kinds: ['trash'], legacyDatabase }),
  ]).records;
  assert.deepStrictEqual(records.map(record => record.id), ['owned-undo']);

  const snapshotResult = run('operations_db.py', 'snapshot', ['--source', operationsDatabase, '--destination', snapshot]);
  assert.strictEqual(snapshotResult.schemaVersion, 1);
  assert.strictEqual(run('operations_db.py', 'undo_record_latest', [
    '--database', snapshot,
    '--payload', '{}',
  ]).record.id, 'owned-undo');

  const replaceFailureDestination = path.join(temporary, 'snapshots', 'replace-failure.sqlite3');
  fs.copyFileSync(snapshot, replaceFailureDestination);
  const beforeReplaceFailure = fs.readFileSync(replaceFailureDestination);
  const durabilityProbe = spawnSync(python, ['-c', [
    'import os,sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(root, 'python'))})`,
    'import operations_db',
    'calls=[]',
    'original_fsync=operations_db.os.fsync',
    'operations_db.os.fsync=lambda fd: calls.append(fd)',
    "operations_db.os.replace=lambda *_args: (_ for _ in ()).throw(OSError('injected replace failure'))",
    'try:',
    '  operations_db.snapshot(sys.argv[1],sys.argv[2])',
    "  raise AssertionError('replace failure ignored')",
    'except OSError as error:',
    "  assert 'injected replace failure' in str(error)",
    'finally:',
    '  operations_db.os.fsync=original_fsync',
    'assert calls',
    "print('operations snapshot durable replace failure test passed')",
  ].join('\n'), operationsDatabase, replaceFailureDestination], { encoding: 'utf8' });
  if (durabilityProbe.status !== 0) throw new Error(durabilityProbe.stderr || durabilityProbe.stdout);
  assert.match(durabilityProbe.stdout, /durable replace failure test passed/);
  assert.deepStrictEqual(fs.readFileSync(replaceFailureDestination), beforeReplaceFailure, 'replace failure preserves the old snapshot');

  console.log('Operations storage isolation tests passed.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
