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
  const racedShortcut = path.join(projectRoot, 'raced.lnk');
  const originalLinkSync = fs.linkSync;
  fs.linkSync = (source, destination) => {
    if (path.resolve(destination) === path.resolve(racedShortcut) && !fs.existsSync(destination)) fs.writeFileSync(destination, 'concurrent placeholder');
    return originalLinkSync(source, destination);
  };
  try {
    assert.throws(() => service.createManagedExternalLink(racedShortcut, { target: externalRoot, kind: 'folder', displayName: 'raced' }), error => error?.code === 'EEXIST');
  } finally { fs.linkSync = originalLinkSync; }
  assert.strictEqual(fs.readFileSync(racedShortcut, 'utf8'), 'concurrent placeholder', 'external-link rollback must retain a concurrent destination placeholder');
  const corruptRegistry = path.join(temporaryRoot, 'corrupt-managed-links.json');
  fs.writeFileSync(corruptRegistry, '{damaged');
  const corruptService = createProjectVirtualPathService({ shell, registryPath: corruptRegistry });
  assert.throws(() => corruptService.createManagedExternalLink(path.join(projectRoot, 'corrupt.lnk'), { target: externalRoot, kind: 'folder', displayName: 'corrupt' }), error => error?.code === 'EXTERNAL_LINK_REGISTRY_CORRUPT');
  assert.strictEqual(fs.readFileSync(corruptRegistry, 'utf8'), '{damaged', 'a damaged registry must never be silently overwritten');
  const fallbackRegistry = path.join(temporaryRoot, 'fallback-managed-links.json');
  const fallbackShortcut = path.join(projectRoot, 'fallback-link.lnk');
  const fallbackService = createProjectVirtualPathService({ shell, registryPath: fallbackRegistry });
  const hardlinkImplementation = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('hard links unavailable'), { code: 'EPERM' }); };
  try { fallbackService.createManagedExternalLink(fallbackShortcut, { target: externalRoot, kind: 'folder', displayName: 'fallback-link' }); }
  finally { fs.linkSync = hardlinkImplementation; }
  assert.strictEqual(fs.existsSync(fallbackShortcut), true, 'external links must fall back to verified COPYFILE_EXCL publication when hard links are unavailable');
  assert.strictEqual(fs.existsSync(fallbackRegistry), true, 'registry publication must use the same no-clobber fallback');
  const fakeResourcesRegistry = path.join(temporaryRoot, 'fake-resources-managed-links.json');
  const fakeResourcesService = createProjectVirtualPathService({ shell, registryPath: fakeResourcesRegistry, resourcesPath: path.join(temporaryRoot, 'missing-resources'), isPackaged: false });
  fakeResourcesService.createManagedExternalLink(path.join(projectRoot, 'fake-resources-link.lnk'), { target: externalRoot, kind: 'folder', displayName: 'fake-resources-link' });
  assert.strictEqual(fs.existsSync(fakeResourcesRegistry), true, 'Electron dev must prefer the existing project helper over a bogus resourcesPath');
  const publisherSpawn = calls => (executable, args) => { calls.push(executable); const operation = args[0]; if (operation === 'move-no-replace') { const source = args[args.indexOf('--source') + 1]; const destination = args[args.indexOf('--target') + 1]; fs.renameSync(source, destination); const stat = fs.statSync(destination); return { stdout: `${JSON.stringify({ success: true, strategy: 'test-native', identity: `${stat.dev}:${stat.ino}` })}\n`, stderr: '', status: 0 }; } const target = args[args.indexOf('--path') + 1]; const stat = fs.statSync(target); return { stdout: `${JSON.stringify({ success: true, identity: `${stat.dev}:${stat.ino}` })}\n`, stderr: '', status: 0 }; };
  const packagedCalls = []; const packagedResources = path.join(temporaryRoot, 'packaged-resources'); const packagedRuntime = path.join(packagedResources, 'app.asar', 'electron', 'services'); const packagedRegistry = path.join(temporaryRoot, 'packaged-managed-links.json');
  const packagedService = createProjectVirtualPathService({ shell, registryPath: packagedRegistry, runtimeDirectory: packagedRuntime, resourcesPath: packagedResources, isPackaged: null, executableExists: () => true, spawnSyncImpl: publisherSpawn(packagedCalls) });
  packagedService.createManagedExternalLink(path.join(projectRoot, 'packaged-helper-link.lnk'), { target: externalRoot, kind: 'folder', displayName: 'packaged-helper-link' });
  assert(packagedCalls.length > 0 && packagedCalls.every(candidate => path.resolve(candidate) === path.resolve(path.join(packagedResources, process.platform === 'win32' ? 'file-publication-service.exe' : 'file-publication-service'))), 'packaged runtime must ignore an apparently existing app.asar helper and execute only extraResources');
  const devCalls = []; const devRuntime = path.join(temporaryRoot, 'dev-project', 'electron', 'services'); const devResources = path.join(temporaryRoot, 'dev-fake-resources'); const devRegistry = path.join(temporaryRoot, 'dev-resolver-managed-links.json');
  const devResolverService = createProjectVirtualPathService({ shell, registryPath: devRegistry, runtimeDirectory: devRuntime, resourcesPath: devResources, isPackaged: null, executableExists: () => true, spawnSyncImpl: publisherSpawn(devCalls) });
  devResolverService.createManagedExternalLink(path.join(projectRoot, 'dev-helper-link.lnk'), { target: externalRoot, kind: 'folder', displayName: 'dev-helper-link' });
  assert(devCalls.length > 0 && devCalls.every(candidate => path.resolve(candidate) === path.resolve(path.join(devRuntime, '..', 'bin', process.platform === 'win32' ? 'file-publication-service.exe' : 'file-publication-service'))), 'development runtime must prefer the project electron/bin helper even when resourcesPath exists');

  const originalRmSync = fs.rmSync;
  fs.rmSync = (candidate, options) => { if (String(candidate).includes(`${path.basename(fallbackRegistry)}.backup-`)) throw Object.assign(new Error('backup cleanup locked'), { code: 'EBUSY' }); return originalRmSync(candidate, options); };
  const backupCleanupShortcut = path.join(projectRoot, 'backup-cleanup-link.lnk');
  try { fallbackService.createManagedExternalLink(backupCleanupShortcut, { target: externalRoot, kind: 'folder', displayName: 'backup-cleanup-link' }); }
  finally { fs.rmSync = originalRmSync; }
  assert.strictEqual(fallbackService.resolve(projectRoot, 'backup-cleanup-link.lnk', { externalRootMode: 'link' }).linkId.length > 0, true, 'backup cleanup failure must not roll back a shortcut after registry commit');

  const crashRegistry = path.join(temporaryRoot, 'crash-managed-links.json');
  const crashService = createProjectVirtualPathService({ shell, registryPath: crashRegistry });
  crashService.createManagedExternalLink(path.join(projectRoot, 'crash-link.lnk'), { target: externalRoot, kind: 'folder', displayName: 'crash-link' });
  const crashSnapshot = JSON.parse(fs.readFileSync(crashRegistry, 'utf8'));
  const crashBackup = `${crashRegistry}.backup-crash`; const crashTemporary = `${crashRegistry}.tmp-crash`;
  fs.copyFileSync(crashRegistry, crashBackup);
  fs.writeFileSync(crashTemporary, JSON.stringify({ ...crashSnapshot, _registryWrite: { ...crashSnapshot._registryWrite, operationId: require('crypto').randomUUID(), generation: crashSnapshot._registryWrite.generation + 1 } }));
  fs.unlinkSync(crashRegistry);
  const recoveredCrashService = createProjectVirtualPathService({ shell, registryPath: crashRegistry });
  assert.strictEqual(recoveredCrashService.listManagedExternalLinks(projectRoot).some(item => item.shortcutVirtualPath === 'crash-link.lnk'), true, 'canonical-to-backup crash must recover the unique legal successor');
  assert.strictEqual(fs.existsSync(crashRegistry), true);

  const partialRegistry = path.join(temporaryRoot, 'partial-managed-links.json'); const partialService = createProjectVirtualPathService({ shell, registryPath: partialRegistry });
  partialService.createManagedExternalLink(path.join(projectRoot, 'partial-link.lnk'), { target: externalRoot, kind: 'folder', displayName: 'partial-link' });
  fs.copyFileSync(partialRegistry, `${partialRegistry}.backup-valid`); fs.writeFileSync(partialRegistry, '{partial');
  const recoveredPartialService = createProjectVirtualPathService({ shell, registryPath: partialRegistry });
  assert.strictEqual(recoveredPartialService.listManagedExternalLinks(projectRoot).some(item => item.shortcutVirtualPath === 'partial-link.lnk'), true, 'an invalid partial canonical must recover from the unique valid backup');
  const posixFaultRegistry = path.join(temporaryRoot, 'posix-fault-managed-links.json'); let injectPosixCrash = false;
  const posixPublisher = (source, destination) => { if (fs.existsSync(destination)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); fs.renameSync(source, destination); const stat = fs.statSync(destination); return { success: true, strategy: 'simulated-posix-renameat2-fsync', identity: `${stat.dev}:${stat.ino}` }; };
  const posixFaultService = createProjectVirtualPathService({ shell, registryPath: posixFaultRegistry, platform: 'linux', nativeRegistryPublisher: posixPublisher, registryFaultInjector: stage => { if (injectPosixCrash && stage === 'after-backup-before-canonical') throw Object.assign(new Error('simulated POSIX registry crash'), { simulateCrash: true }); } });
  posixFaultService.createManagedExternalLink(path.join(projectRoot, 'posix-first.lnk'), { target: externalRoot, kind: 'folder', displayName: 'posix-first' }); injectPosixCrash = true;
  assert.throws(() => posixFaultService.createManagedExternalLink(path.join(projectRoot, 'posix-second.lnk'), { target: externalRoot, kind: 'folder', displayName: 'posix-second' }), /POSIX registry crash/);
  const recoveredPosixService = createProjectVirtualPathService({ shell, registryPath: posixFaultRegistry, platform: 'linux', nativeRegistryPublisher: posixPublisher });
  assert.doesNotThrow(() => recoveredPosixService.listManagedExternalLinks(projectRoot)); assert.strictEqual(fs.existsSync(posixFaultRegistry), true, 'POSIX crash recovery must atomically promote the unique synced successor');

  const ambiguousRegistry = path.join(temporaryRoot, 'ambiguous-managed-links.json'); const ambiguousValue = { version: 1, links: {} };
  fs.writeFileSync(`${ambiguousRegistry}.backup-a`, JSON.stringify(ambiguousValue)); fs.writeFileSync(`${ambiguousRegistry}.backup-b`, JSON.stringify(ambiguousValue));
  const ambiguousService = createProjectVirtualPathService({ shell, registryPath: ambiguousRegistry });
  assert.throws(() => ambiguousService.listManagedExternalLinks(projectRoot), error => error?.code === 'EXTERNAL_LINK_REGISTRY_RECOVERY_AMBIGUOUS');
  const invalidAmbiguousRegistry = path.join(temporaryRoot, 'invalid-ambiguous-managed-links.json'); fs.writeFileSync(invalidAmbiguousRegistry, '{invalid'); fs.writeFileSync(`${invalidAmbiguousRegistry}.backup-a`, JSON.stringify(ambiguousValue)); fs.writeFileSync(`${invalidAmbiguousRegistry}.backup-b`, JSON.stringify(ambiguousValue));
  const invalidAmbiguousService = createProjectVirtualPathService({ shell, registryPath: invalidAmbiguousRegistry });
  assert.throws(() => invalidAmbiguousService.listManagedExternalLinks(projectRoot), /损坏|恢复候选|歧义/, 'an invalid canonical with multiple valid candidates must fail closed');
  service.createManagedExternalLink(path.join(projectRoot, 'RAW.lnk'), { target: externalRoot, kind: 'folder', displayName: 'RAW' });
  service.createManagedExternalLink(path.join(projectRoot, 'linked-photo.jpg.lnk'), { target: externalFile, kind: 'file', displayName: 'linked-photo.jpg' });
  const boundedRoot = path.join(projectRoot, 'bounded-scan'); fs.mkdirSync(path.join(boundedRoot, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(boundedRoot, 'a', 'ordinary.txt'), 'ordinary');
  const bounded = service.listManagedExternalLinks(projectRoot, { maxEntries: 1, maxDirectories: 2, maxDepth: 1 });
  assert.strictEqual(Array.isArray(bounded), true);
  assert.strictEqual(bounded.truncated, true, 'managed external-link enumeration must expose bounded truncation without changing its Array return type');
  const cancelledScan = service.listManagedExternalLinks(projectRoot, { cancel: () => true });
  assert.strictEqual(cancelledScan.cancelled, true);
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
