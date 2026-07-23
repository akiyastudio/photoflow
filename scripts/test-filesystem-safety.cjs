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

    const projectPath = path.join(workspace, 'progress-project');
    const progressPath = path.join(projectPath, '待处理图片');
    fs.mkdirSync(projectPath);
    fs.mkdirSync(progressPath);
    runJson(python, [script, 'add', '--root', workspace, '--database', database, '--payload', JSON.stringify({ name: 'progress-project', status: '未分类', relativePath: 'progress-project' })]);
    const selectionPath = path.join(projectPath, '图片选片');
    fs.mkdirSync(selectionPath);
    const selectedOriginal = path.join(selectionPath, 'selected.jpg');
    fs.writeFileSync(selectedOriginal, 'selected-original');
    runJson(python, [script, 'progress_register', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', mediaKind: 'image', versionKey: '0',
      displayName: '图片选片（原图）', folderPath: selectionPath, trackingEnabled: true,
    })]);
    runJson(python, [script, 'batch_register_baseline', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', folderPath: selectionPath, versionName: '图片选片（原图）',
    })]);
    const selectedBundle = runJson(python, [script, 'media_get', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', filePath: selectedOriginal,
    })]);
    assert.strictEqual(selectedBundle.versions[0].versionNumber, 0);
    assert.strictEqual(selectedBundle.versions[0].versionName, '图片选片（原图）');
    fs.writeFileSync(path.join(selectionPath, 'selected-later.jpg'), 'selected-later');
    const refreshedBaseline = runJson(python, [script, 'batch_register_baseline', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', folderPath: selectionPath, versionName: '图片选片（原图）',
    })]);
    assert.strictEqual(refreshedBaseline.batch.itemCount, 2, 'later selections must join the existing V0 baseline');
    runJson(python, [script, 'progress_register', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', mediaKind: 'image', versionKey: '2',
      displayName: '图片后期_2_调色', folderPath: progressPath, trackingEnabled: false,
    })]);
    runJson(python, [script, 'progress_list', '--root', workspace, '--database', database, '--payload', JSON.stringify({ projectName: 'progress-project' })]);
    const renamedProgressPath = path.join(projectPath, '已经改名的图片');
    fs.renameSync(progressPath, renamedProgressPath);
    const progressAfterRename = runJson(python, [script, 'progress_list', '--root', workspace, '--database', database, '--payload', JSON.stringify({ projectName: 'progress-project' })]).progressFolders.find(folder => folder.versionKey === '2');
    assert.strictEqual(progressAfterRename.displayName, '图片后期_2_调色', 'folder rename must not rename progress display name');
    assert.strictEqual(path.resolve(progressAfterRename.folderPath), path.resolve(renamedProgressPath), 'progress folder path must follow the renamed folder');

    const referenceFolder = path.join(projectPath, '图片后期_1');
    const sourceFolder = path.join(projectPath, '图片后期_2');
    fs.mkdirSync(referenceFolder);
    fs.mkdirSync(sourceFolder);
    const referenceFile = path.join(referenceFolder, 'reference.jpg');
    const sourceFile = path.join(sourceFolder, 'source.jpg');
    fs.writeFileSync(referenceFile, 'reference-image');
    fs.writeFileSync(sourceFile, 'updated-image');
    runJson(python, [script, 'batch_commit_compare', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', folderA: referenceFolder, folderB: sourceFolder,
      displayName: '图片后期_2', renameSources: true,
      matches: [{ reference: 'reference.jpg', source: 'source.jpg', target: 'reference.jpg', distance: 0, confidence: 'high' }],
    })]);
    const renamedSourceFile = path.join(sourceFolder, 'reference.jpg');
    const tracked = runJson(python, [script, 'media_get', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', filePath: renamedSourceFile,
    })]);
    const trackedCurrent = tracked.versions.find(version => version.isCurrent);
    assert.strictEqual(path.resolve(trackedCurrent.filePath), path.resolve(renamedSourceFile), 'batch version must track the real renamed source file');
    assert.strictEqual(trackedCurrent.versionName, '图片后期_2', 'batch version display name must use the progress name without an R sequence prefix');
    assert.strictEqual(fs.existsSync(path.join(projectPath, 'Versions')), false, 'batch tracking must not create a Versions history library');
    runJson(python, [script, 'media_update_version', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      versionId: trackedCurrent.id, isFinal: true,
    })]);
    const finalVersions = runJson(python, [script, 'final_version_list', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project',
    })]);
    assert.strictEqual(finalVersions.count, 1, 'project must expose its marked final image');
    assert.strictEqual(finalVersions.missingCount, 0, 'an existing final image must be available for export');
    assert.strictEqual(path.resolve(finalVersions.versions[0].filePath), path.resolve(renamedSourceFile));
    const externallyRenamedSource = path.join(sourceFolder, 'final-renamed.jpg');
    fs.renameSync(renamedSourceFile, externallyRenamedSource);
    runJson(python, [script, 'media_sync_project', '--root', workspace, '--database', database, '--payload', JSON.stringify({ projectName: 'progress-project' })]);
    const finalsAfterRename = runJson(python, [script, 'final_version_list', '--root', workspace, '--database', database, '--payload', JSON.stringify({ projectName: 'progress-project' })]);
    assert.strictEqual(path.resolve(finalsAfterRename.versions[0].filePath), path.resolve(externallyRenamedSource), 'a final batch version must follow an external source rename');

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
