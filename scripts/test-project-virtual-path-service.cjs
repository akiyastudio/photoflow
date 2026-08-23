const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProjectVirtualPathService, MANAGED_EXTERNAL_FOLDER_PREFIX, MANAGED_EXTERNAL_FILE_PREFIX } = require('../electron/services/project-virtual-path-service.cjs');
const { registerFileOperationsIpc } = require('../electron/modules/files-ipc.cjs');
const { createSelectionService } = require('../electron/services/selection-service.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-virtual-path-'));
const run = async () => {
try {
  const projectRoot = path.join(temporaryRoot, 'project');
  const externalRoot = path.join(temporaryRoot, 'external');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(externalRoot);
  fs.mkdirSync(path.join(externalRoot, 'nested'));
  fs.writeFileSync(path.join(externalRoot, 'nested', 'photo.jpg'), 'photo');
  const externalFile = path.join(temporaryRoot, 'linked-photo.jpg');
  fs.writeFileSync(externalFile, 'linked-photo');
  fs.writeFileSync(path.join(projectRoot, 'ordinary.lnk'), JSON.stringify({ target: externalRoot, description: 'ordinary shortcut' }));
  fs.writeFileSync(path.join(projectRoot, 'spoofed.lnk'), JSON.stringify({ target: externalRoot, description: `${MANAGED_EXTERNAL_FOLDER_PREFIX}spoofed` }));

  const shell = {
    readShortcutLink: shortcutPath => JSON.parse(fs.readFileSync(shortcutPath, 'utf8')),
    writeShortcutLink: (shortcutPath, details) => { fs.writeFileSync(shortcutPath, JSON.stringify(details)); return true; },
  };
  const service = createProjectVirtualPathService({ shell, registryPath: path.join(temporaryRoot, 'managed-links.json') });
  service.createManagedExternalLink(path.join(projectRoot, 'RAW.lnk'), { target: externalRoot, kind: 'folder', displayName: 'RAW' });
  service.createManagedExternalLink(path.join(projectRoot, 'linked-photo.jpg.lnk'), { target: externalFile, kind: 'file', displayName: 'linked-photo.jpg' });
  const rootAsLink = service.resolve(projectRoot, 'RAW.lnk', { externalRootMode: 'link' });
  assert.strictEqual(rootAsLink.physicalPath, path.join(projectRoot, 'RAW.lnk'));
  assert.strictEqual(rootAsLink.isExternalLinkRoot, true);
  assert.strictEqual(rootAsLink.viaExternalLink, true);

  const rootAsFolder = service.resolve(projectRoot, 'RAW.lnk', { externalRootMode: 'target' });
  assert.strictEqual(rootAsFolder.physicalPath, fs.realpathSync(externalRoot));
  assert.strictEqual(rootAsFolder.mediaRoot, fs.realpathSync(externalRoot));

  const media = service.resolve(projectRoot, 'RAW.lnk/nested/photo.jpg');
  assert.strictEqual(media.physicalPath, fs.realpathSync(path.join(externalRoot, 'nested', 'photo.jpg')));
  assert.strictEqual(service.toVirtualPath(projectRoot, media.physicalPath, media), 'RAW.lnk/nested/photo.jpg');

  const destination = service.resolve(projectRoot, 'RAW.lnk/nested/new.jpg', { mustExist: false, allowMissingLeaf: true });
  assert.strictEqual(destination.physicalPath, path.join(fs.realpathSync(externalRoot), 'nested', 'new.jpg'));

  const linkedFile = service.resolve(projectRoot, 'linked-photo.jpg.lnk', { externalRootMode: 'target' });
  assert.strictEqual(linkedFile.physicalPath, fs.realpathSync(externalFile));
  assert.strictEqual(linkedFile.externalTargetKind, 'file');
  assert.strictEqual(service.toVirtualPath(projectRoot, linkedFile.physicalPath, linkedFile), 'linked-photo.jpg.lnk');
  assert.throws(() => service.resolve(projectRoot, 'linked-photo.jpg.lnk/child'), /不能包含子路径/);

  fs.writeFileSync(path.join(externalRoot, 'IMG_1001.jpg'), 'select-me');
  const selection = createSelectionService({
    fs, crypto: require('crypto'), copyFileAtomic: async () => undefined, projectVirtualPaths: service,
    versionService: { listProgress: async () => ({ progressFolders: [] }) },
    imageExtensions: new Set(['.jpg']), rawExtensions: new Set(), videoExtensions: new Set(),
  });
  const selectionPlan = await selection.preflightManual({
    workspaceRoot: temporaryRoot, projectName: 'project', projectRoot,
    sourceFolderRelativePath: 'RAW.lnk', relativePaths: ['RAW.lnk/IMG_1001.jpg'],
  });
  assert.strictEqual(selectionPlan.success, true);
  assert.strictEqual(selectionPlan.sourceFolderRelativePath, 'RAW.lnk');
  assert.strictEqual(selectionPlan.targetFolderRelativePath, '图片选片', 'external selection output must remain visible inside the project');

  assert.throws(() => service.resolve(projectRoot, 'RAW.lnk/../outside.jpg'), /项目路径无效/);
  assert.throws(() => service.resolve(projectRoot, 'ordinary.lnk', { externalRootMode: 'target' }), /不是 PhotoFlow 外链/);
  assert.throws(() => service.resolve(projectRoot, 'spoofed.lnk', { externalRootMode: 'target' }), /不是 PhotoFlow 外链/, 'a copied description without a registered identity must not gain external write authority');

  const outsideJunctionTarget = path.join(temporaryRoot, 'junction-outside');
  fs.mkdirSync(outsideJunctionTarget);
  fs.writeFileSync(path.join(outsideJunctionTarget, 'escape.jpg'), 'escape');
  const junctionPath = path.join(projectRoot, 'junction');
  let junctionAvailable = false;
  try {
    fs.symlinkSync(outsideJunctionTarget, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
    junctionAvailable = true;
    assert.throws(() => service.resolve(projectRoot, 'junction/escape.jpg'), /重解析点|项目目录/, 'ordinary project paths must not escape through a junction');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
    process.stdout.write(`SKIP: junction escape test unavailable (${error.code})\n`);
  }

  const externalShortcutOutside = path.join(outsideJunctionTarget, 'escape-link.lnk');
  service.createManagedExternalLink(externalShortcutOutside, { target: externalRoot, kind: 'folder', displayName: 'escape-link' });
  if (junctionAvailable) {
    assert.throws(
      () => service.resolve(projectRoot, 'junction/escape-link.lnk', { externalRootMode: 'link' }),
      /重解析点|项目目录/,
      'managed external shortcuts must not escape through a junction',
    );
    assert.strictEqual(fs.existsSync(externalShortcutOutside), true, 'a rejected external shortcut must remain untouched outside the project');
  }

  const listed = service.listManagedExternalLinks(projectRoot);
  assert.deepStrictEqual(listed.map(item => item.shortcutVirtualPath).sort(), ['RAW.lnk', 'linked-photo.jpg.lnk']);
  assert(listed.every(item => item.offline === false));

  const handlers = new Map();
  registerFileOperationsIpc({
    Array, Boolean, Date, Error, Math, Promise, Set, String, process, crypto: require('crypto'),
    fs, path, projectVirtualPaths: service, getProjectPath: () => projectRoot,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => undefined },
    activeProjectFileOperations: new Map(), fileOperationState: { projectFileClipboard: null },
    cancelMediaTrackingScan: () => undefined, ensureWorkspace: value => value, pushUndoOperation: async () => undefined,
    capturePathIdentity: async filePath => ({ path: filePath }),
    workspaceRepository: { addUndoRecord: async () => ({ id: 'undo' }) },
    recycleBinService: { trash: async filePath => { fs.rmSync(filePath, { recursive: true, force: true }); return { recyclePidl: 'test', preciseRestore: true, permanent: false }; } },
    writeLog: () => undefined,
  });
  const rename = handlers.get('workspace-file-operation');
  const childRename = await rename({ sender: { isDestroyed: () => false, send: () => undefined } }, 'workspace', 'active', 'project', 'rename', ['RAW.lnk/nested/photo.jpg'], '', 'renamed.jpg');
  assert.strictEqual(childRename.success, true, childRename.error);
  assert.strictEqual(fs.existsSync(path.join(externalRoot, 'nested', 'renamed.jpg')), true);
  assert.deepStrictEqual(childRename.movedItems[0], { sourceRelativePath: 'RAW.lnk/nested/photo.jpg', destinationRelativePath: 'RAW.lnk/nested/renamed.jpg' });

  const rootRename = await rename({ sender: { isDestroyed: () => false, send: () => undefined } }, 'workspace', 'active', 'project', 'rename', ['RAW.lnk'], '', 'Originals');
  assert.strictEqual(rootRename.success, true, rootRename.error);
  assert.strictEqual(fs.existsSync(path.join(projectRoot, 'Originals.lnk')), true, 'renaming an external root must preserve the managed .lnk reference');
  assert.strictEqual(fs.existsSync(externalRoot), true, 'renaming an external root must not rename its target folder');
  fs.renameSync(path.join(projectRoot, 'Originals.lnk'), path.join(projectRoot, 'RAW.lnk'));

  fs.renameSync(externalRoot, `${externalRoot}-offline`);
  const offlineLink = service.resolve(projectRoot, 'RAW.lnk', { externalRootMode: 'link' });
  assert.strictEqual(offlineLink.offline, true);
  assert.throws(() => service.resolve(projectRoot, 'RAW.lnk/nested/photo.jpg'), error => error?.code === 'EXTERNAL_LINK_OFFLINE');
  const restartedService = createProjectVirtualPathService({ shell, registryPath: path.join(temporaryRoot, 'managed-links.json') });
  const restartedOfflineLink = restartedService.listManagedExternalLinks(projectRoot)
    .find(item => item.shortcutVirtualPath === 'RAW.lnk');
  assert.strictEqual(restartedOfflineLink?.offline, true, 'managed registry authority must survive restart while its target is offline');
  fs.renameSync(`${externalRoot}-offline`, externalRoot);
  assert.strictEqual(
    restartedService.listManagedExternalLinks(projectRoot).find(item => item.shortcutVirtualPath === 'RAW.lnk')?.offline,
    false,
    'a managed external link must become enumerable again when its target returns online',
  );

  const detach = await rename({ sender: { isDestroyed: () => false, send: () => undefined } }, 'workspace', 'active', 'project', 'trash', ['RAW.lnk']);
  assert.strictEqual(detach.success, true, detach.error);
  assert.strictEqual(fs.existsSync(path.join(projectRoot, 'RAW.lnk')), false, 'deleting an external root must detach the project link');
  assert.strictEqual(fs.existsSync(externalRoot), true, 'deleting an external root must never delete its target folder');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('project virtual-path service tests passed\n');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
