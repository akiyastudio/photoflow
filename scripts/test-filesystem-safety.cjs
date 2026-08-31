const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { capturePathIdentity, samePathIdentity, assertUndoIdentity } = require('../electron/services/file-identity-service.cjs');
const { createMediaAccessService } = require('../electron/services/media-access-service.cjs');
const fileTransferSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'file-transfer-service.cjs'), 'utf8');
assert(fileTransferSource.includes('await collectCopyPlan(resolvedSource, temporary, plan') && fileTransferSource.includes('nativeService.inspectPath(entry.source)') && fileTransferSource.includes('nativeService.commitTreeFile') && fileTransferSource.includes('nativeService.deleteEmptyDirectory'), 'cross-volume directory moves must use planned identities and locked native per-entry cleanup');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-safety-test-'));
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
fs.mkdirSync(workspace);
fs.mkdirSync(outside);

const runJson = (command, args, input) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, input });
  const lines = String(result.stdout || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const payload = JSON.parse(lines[lines.length - 1]);
  if (!payload.success) throw new Error(payload.error || String(result.stderr));
  return payload;
};

const syncMediaProject = (python, script, workspace, database, projectName) => {
  const invoke = (action, payload) => runJson(python, [script, action, '--root', workspace, '--database', database, '--payload', JSON.stringify(payload)]);
  const prepared = invoke('media_sync_prepare', { projectName });
  for (let offset = 0, batchIndex = 0; offset < prepared.files.length; offset += 64, batchIndex += 1) {
    invoke('media_sync_apply_batch', {
      projectName, snapshotId: prepared.snapshotId, batchIndex,
      authorizedRoots: prepared.authorizedRoots, files: prepared.files.slice(offset, offset + 64),
    });
  }
  return invoke('media_sync_finalize', {
    projectName, snapshotId: prepared.snapshotId, authorizedRoots: prepared.authorizedRoots,
    files: prepared.files, baselineVersions: prepared.baselineVersions,
  });
};

(async () => {
  try {
    const original = path.join(workspace, 'identity.txt');
    fs.writeFileSync(original, 'original');
    const identity = await capturePathIdentity(original);
    fs.renameSync(original, path.join(workspace, 'moved.txt'));
    fs.writeFileSync(original, 'replacement');
    assert.strictEqual(await samePathIdentity(original, identity), false, 'a same-path replacement must not pass undo identity validation');
    const inPlace = path.join(workspace, 'identity-in-place.txt');
    fs.writeFileSync(inPlace, 'before!!');
    const inPlaceIdentity = await capturePathIdentity(inPlace);
    const inPlaceHandle = fs.openSync(inPlace, 'r+');
    try { fs.writeSync(inPlaceHandle, Buffer.from('after!!!'), 0, 8, 0); fs.fsyncSync(inPlaceHandle); }
    finally { fs.closeSync(inPlaceHandle); }
    fs.utimesSync(inPlace, new Date(), new Date(Date.now() + 2000));
    const rewrittenIdentity = await capturePathIdentity(inPlace);
    if (process.platform !== 'win32') assert.strictEqual(rewrittenIdentity.inode, inPlaceIdentity.inode, 'the regression fixture must retain the same inode');
    const sameNativeIdentityFixture = { ...inPlaceIdentity, device: rewrittenIdentity.device, inode: rewrittenIdentity.inode };
    assert.strictEqual(await samePathIdentity(inPlace, sameNativeIdentityFixture), false, 'same-inode in-place rewrites must fail identity validation');
    const legacyIdentity = { device: inPlaceIdentity.device, inode: inPlaceIdentity.inode, size: inPlaceIdentity.size, modifiedNs: inPlaceIdentity.modifiedNs, directory: false };
    assert.strictEqual(await samePathIdentity(inPlace, legacyIdentity, { destructive: true }), false, 'legacy identities without kind/ctime must be rejected for destructive cleanup');
    await assert.rejects(assertUndoIdentity({ identities: { [path.resolve(inPlace)]: legacyIdentity } }, inPlace), error => error?.code === 'LEGACY_UNDO_UNSAFE', 'legacy destructive undo rejection must expose an explicit compatibility error');

    const broker = createMediaAccessService({ getWorkspaceRoots: () => [workspace] });
    assert.strictEqual(await broker.authorizeInput(original), fs.realpathSync(original));
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    await assert.rejects(() => broker.authorizeInput(outsideFile), /未经授权|不在已授权/);
    broker.grantRoot(outside);
    assert.strictEqual(await broker.authorizeInput(outsideFile), fs.realpathSync(outsideFile), 'a validated external browser root must authorize its returned media files');
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
    runJson(python, [script, 'add', '--root', workspace, '--database', database, '--payload', JSON.stringify({ name: 'progress-project', status: '未分类', relativePath: 'progress-project', extra: { projectDate: { year: 2026, month: 7, precision: 'month' } } })]);
    const datedProject = runJson(python, [script, 'init', '--root', workspace, '--database', database]).projects.find(project => project.name === 'progress-project');
    assert.deepStrictEqual(JSON.parse(datedProject.extra_json).projectDate, { year: 2026, month: 7, precision: 'month' }, 'project date metadata must survive catalog reloads');
    const selectionPath = path.join(projectPath, '图片选片');
    fs.mkdirSync(selectionPath);
    const selectedOriginal = path.join(selectionPath, 'selected.jpg');
    fs.writeFileSync(selectedOriginal, 'selected-original');
    runJson(python, [script, 'progress_register', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', mediaKind: 'image', versionKey: '0',
      displayName: '图片选片（原图）', folderPath: selectionPath, nodeRole: 'original', trackingEnabled: false,
    })]);
    const repeatedSelectionProgress = runJson(python, [script, 'progress_register', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', mediaKind: 'image', versionKey: '0',
      displayName: '图片选片（原图）', folderPath: selectionPath, nodeRole: 'original', trackingEnabled: false,
    })]);
    assert.strictEqual(repeatedSelectionProgress.progressFolder.versionKey, '0', 'ensuring the selection baseline repeatedly must be idempotent');
    const nestedProgressPath = path.join(projectPath, '外部结构', '交付批次');
    fs.mkdirSync(nestedProgressPath, { recursive: true });
    const nestedProgress = runJson(python, [script, 'progress_register', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', mediaKind: 'image', versionKey: '7',
      parentProgressId: repeatedSelectionProgress.progressFolder.id, relationKind: 'main',
      displayName: '图片后期_7_接管', folderPath: nestedProgressPath, trackingEnabled: false,
    })]).progressFolder;
    assert.strictEqual(path.resolve(nestedProgress.folderPath), path.resolve(nestedProgressPath), 'any descendant folder must be eligible for version progress');
    const updatedNestedProgress = runJson(python, [script, 'progress_update_tree', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', primaryProgressId: nestedProgress.id,
      updates: [{ id: nestedProgress.id, mediaKind: 'image', versionKey: '8', parentProgressId: repeatedSelectionProgress.progressFolder.id, displayName: '图片后期_8_接管', folderPath: nestedProgressPath, trackingEnabled: false, trackingState: 'disabled' }],
    })]).progressFolders.find(folder => folder.id === nestedProgress.id);
    assert.strictEqual(path.resolve(updatedNestedProgress.folderPath), path.resolve(nestedProgressPath), 'editing adopted progress metadata must preserve its nested physical path');
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
    fs.unlinkSync(selectedOriginal);
    const prunedBaseline = runJson(python, [script, 'batch_register_baseline', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', folderPath: selectionPath, versionName: '图片选片（原图）',
    })]);
    assert.strictEqual(prunedBaseline.batch.itemCount, 1, 'refreshing a V0 baseline must remove files that no longer exist in the selection folder');
    runJson(python, [script, 'progress_register', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', mediaKind: 'image', versionKey: '2',
      parentProgressId: repeatedSelectionProgress.progressFolder.id, relationKind: 'main',
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
    fs.appendFileSync(renamedSourceFile, 'xmp-rating-metadata');
    const metadataRefresh = runJson(python, [script, 'media_refresh_metadata_fingerprint', '--root', workspace, '--database', database, '--payload', JSON.stringify({ filePath: renamedSourceFile })]);
    assert.strictEqual(metadataRefresh.updatedCount, 1, 'metadata-only writes must refresh the tracked fingerprint');
    const afterMetadataRefresh = runJson(python, [script, 'media_get', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      projectName: 'progress-project', filePath: renamedSourceFile,
    })]).versions.find(version => version.id === trackedCurrent.id);
    assert.strictEqual(afterMetadataRefresh.contentChanged, false, 'an accepted metadata rating write must not become a visual version change');
    assert.strictEqual(afterMetadataRefresh.fileSize, fs.statSync(renamedSourceFile).size);
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
    syncMediaProject(python, script, workspace, database, 'progress-project');
    const finalsAfterRename = runJson(python, [script, 'final_version_list', '--root', workspace, '--database', database, '--payload', JSON.stringify({ projectName: 'progress-project' })]);
    assert.strictEqual(path.resolve(finalsAfterRename.versions[0].filePath), path.resolve(externallyRenamedSource), 'a final batch version must follow an external source rename');

    const datedRenameSource = path.join(workspace, '26-7 old-name');
    const datedRenameTarget = path.join(workspace, '26-8-2 new-name');
    fs.mkdirSync(datedRenameSource);
    runJson(python, [script, 'add', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      name: '26-7 old-name', status: '策划中', relativePath: '26-7 old-name',
      extra: { projectDate: { year: 2026, month: 7, precision: 'month' } },
    })]);
    fs.renameSync(datedRenameSource, datedRenameTarget);
    runJson(python, [script, 'rename', '--root', workspace, '--database', database, '--payload', JSON.stringify({
      name: '26-7 old-name', nextName: '26-8-2 new-name', relativePath: '26-8-2 new-name',
      projectDate: { year: 2026, month: 8, day: 2, precision: 'day' },
    })]);
    const renamedDatedProject = runJson(python, [script, 'init', '--root', workspace, '--database', database]).projects.find(project => project.name === '26-8-2 new-name');
    assert(renamedDatedProject, 'renamed project must remain in the workspace catalog');
    assert.deepStrictEqual(JSON.parse(renamedDatedProject.extra_json).projectDate, { year: 2026, month: 8, day: 2, precision: 'day' }, 'renaming a project must update its date metadata');

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

          const batchFiles = ['批量甲.txt', 'batch-b.txt'].map(name => path.join(workspace, name));
          for (const filePath of batchFiles) fs.writeFileSync(filePath, `restore ${path.basename(filePath)}`);
          const batch = runJson(helper, ['trash-many'], JSON.stringify(batchFiles));
          assert.strictEqual(batch.items.length, batchFiles.length);
          assert(batch.items.every(item => item.success && item.recyclePidl), 'batch recycle must preserve a precise restore identity for every item');
          for (let index = 0; index < batchFiles.length; index += 1) {
            assert.strictEqual(fs.existsSync(batchFiles[index]), false);
            runJson(helper, ['restore', '--pidl', batch.items[index].recyclePidl, '--target', batchFiles[index]]);
            assert.strictEqual(fs.readFileSync(batchFiles[index], 'utf8'), `restore ${path.basename(batchFiles[index])}`);
          }
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
