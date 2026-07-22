const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { capturePathIdentity, samePathIdentity } = require('../electron/services/file-identity-service.cjs');
const { createMediaAccessService } = require('../electron/services/media-access-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-safety-test-'));
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
fs.mkdirSync(workspace);
fs.mkdirSync(outside);

const runJson = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  const lines = String(result.stdout || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const payload = JSON.parse(lines[lines.length - 1]);
  if (!payload.success) throw new Error(payload.error || String(result.stderr));
  return payload;
};

(async () => {
  try {
    const original = path.join(workspace, 'identity.txt');
    fs.writeFileSync(original, 'original');
    const identity = await capturePathIdentity(original);
    fs.renameSync(original, path.join(workspace, 'moved.txt'));
    fs.writeFileSync(original, 'replacement');
    assert.strictEqual(await samePathIdentity(original, identity), false, 'a same-path replacement must not pass undo identity validation');

    const broker = createMediaAccessService({ getWorkspaceRoots: () => [workspace] });
    assert.strictEqual(await broker.authorizeInput(original), fs.realpathSync(original));
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    await assert.rejects(() => broker.authorizeInput(outsideFile), /未经授权|不在已授权/);
    const token = broker.grantPath(original);
    assert.strictEqual(broker.resolveToken(token), path.resolve(original));
    assert.strictEqual(broker.resolveToken('forged-token'), null);

    const python = process.platform === 'win32'
      ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '..', '.venv', 'bin', 'python');
    const script = path.join(__dirname, '..', 'python', 'workspace_db.py');
    const database = path.join(root, 'workspace.sqlite3');
    runJson(python, [script, 'init', '--root', workspace, '--database', database]);
    const added = runJson(python, [script, 'undo_record_add', '--root', workspace, '--database', database, '--payload', JSON.stringify({ kind: 'trash', payload: { items: [{ original: original, recyclePidl: 'test' }] } })]);
    const latest = runJson(python, [script, 'undo_record_latest', '--root', workspace, '--database', database]);
    assert.strictEqual(latest.record.id, added.id);
    assert.strictEqual(latest.record.payload.items[0].recyclePidl, 'test');
    runJson(python, [script, 'undo_record_remove', '--root', workspace, '--database', database, '--payload', JSON.stringify({ id: added.id })]);
    assert.strictEqual(runJson(python, [script, 'undo_record_latest', '--root', workspace, '--database', database]).record, null);

    if (process.platform === 'win32') {
      const helper = path.join(__dirname, '..', 'electron', 'bin', 'recycle-bin-service.exe');
      if (fs.existsSync(helper)) {
        const check = runJson(helper, ['check', '--directory', workspace]);
        assert.strictEqual(typeof check.supported, 'boolean');
        assert.strictEqual(fs.readdirSync(workspace).some(name => name.startsWith('.photoflow-recycle-check-')), false);
        if (check.supported) {
          const recycleFile = path.join(workspace, 'recycle.txt');
          fs.writeFileSync(recycleFile, 'restore me');
          const recycled = runJson(helper, ['trash', '--path', recycleFile]);
          assert.strictEqual(fs.existsSync(recycleFile), false);
          runJson(helper, ['restore', '--pidl', recycled.recyclePidl, '--target', recycleFile]);
          assert.strictEqual(fs.readFileSync(recycleFile, 'utf8'), 'restore me');
        }
      }
    }
    console.log('filesystem safety tests passed');
  } finally {
    const resolved = path.resolve(root);
    const temporaryRoot = path.resolve(os.tmpdir());
    if (resolved.startsWith(temporaryRoot + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
