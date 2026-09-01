const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createStorageUsageService } = require('../electron/services/storage-usage-service.cjs');
const { registerStorageUsageIpc } = require('../electron/modules/storage-usage-ipc.cjs');
const { loadOrCreateInstallationId, resolveMediaCacheNamespace } = require('../electron/services/media-cache-namespace.cjs');

const run = async () => {
  const ipcHandlers = new Map();
  const ipcMain = { handle: (channel, handler) => ipcHandlers.set(channel, handler), removeHandler: channel => ipcHandlers.delete(channel) };
  const trustedWebContents = { mainFrame: {}, isDestroyed: () => false };
  const mainWindow = { isDestroyed: () => false, webContents: trustedWebContents };
  const disposeIpc = registerStorageUsageIpc({
    ipcMain,
    storageUsageService: { overview: async force => ({ success: true, force }) },
    getMainWindow: () => mainWindow,
  });
  const overviewHandler = ipcHandlers.get('storage-usage-overview');
  assert.deepEqual(await overviewHandler({ sender: trustedWebContents, senderFrame: trustedWebContents.mainFrame }, true), { success: true, force: true });
  await assert.rejects(overviewHandler({ sender: { mainFrame: {}, isDestroyed: () => false } }, false), /Unauthorized IPC sender/);
  disposeIpc();
  const missingDependencyHandlers = new Map();
  registerStorageUsageIpc({
    ipcMain: { handle: (channel, handler) => missingDependencyHandlers.set(channel, handler), removeHandler() {} },
    storageUsageService: null,
    getMainWindow: () => mainWindow,
  });
  const unavailable = await missingDependencyHandlers.get('storage-usage-overview')({ sender: trustedWebContents, senderFrame: trustedWebContents.mainFrame }, false);
  assert.equal(unavailable.code, 'STORAGE_USAGE_UNAVAILABLE', 'missing storage service dependencies must fail closed');
  const missingWindowHandlers = new Map();
  registerStorageUsageIpc({
    ipcMain: { handle: (channel, handler) => missingWindowHandlers.set(channel, handler), removeHandler() {} },
    storageUsageService: { overview: async () => ({ success: true }) },
  });
  await assert.rejects(missingWindowHandlers.get('storage-usage-overview')({ sender: trustedWebContents }, false), /Unauthorized IPC sender/, 'missing main-window identity must fail closed');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-storage-usage-'));
  try {
    const workspace = path.join(root, 'workspace');
    const secondaryWorkspace = path.join(root, 'workspace-secondary');
    const archive = path.join(root, 'archive');
    const backup = path.join(root, 'backup');
    const cache = path.join(root, 'cache');
    const inspiration = path.join(root, 'inspiration');
    const userData = path.join(root, 'user-data');
    const installationId = loadOrCreateInstallationId({ fs, path, crypto, userDataPath: userData });
    assert.equal(loadOrCreateInstallationId({ fs, path, crypto, userDataPath: userData }), installationId, 'installation ID must remain stable');
    assert.equal(resolveMediaCacheNamespace({ path, userDataPath: userData, installationId, configuredDirectory: '' }), path.join(userData, 'media-cache'));
    const cacheNamespace = resolveMediaCacheNamespace({ path, userDataPath: userData, installationId, configuredDirectory: cache });
    const foreignCacheNamespace = resolveMediaCacheNamespace({ path, userDataPath: userData, installationId: '11111111-1111-4111-8111-111111111111', configuredDirectory: cache });
    assert.notEqual(cacheNamespace, foreignCacheNamespace);
    const workspaceData = path.join(userData, 'workspace-data', 'ws01');
    const database = path.join(userData, 'workspace-data', 'ws01.sqlite3');
    await Promise.all([workspace, secondaryWorkspace, path.join(archive, 'ws01'), path.join(backup, '.photoflow-backup'), cacheNamespace, foreignCacheNamespace, inspiration, workspaceData].map(directory => fs.promises.mkdir(directory, { recursive: true })));
    const files = [
      [path.join(workspace, '.photoflow-workspace-id'), 'ws01\n'],
      [path.join(workspace, 'photo.raw'), 'w'.repeat(11)],
      [path.join(secondaryWorkspace, 'second.raw'), 's'.repeat(7)],
      [path.join(archive, 'ws01', 'archived.raw'), 'a'.repeat(13)],
      [path.join(backup, '.photoflow-backup', 'object'), 'b'.repeat(17)],
      [path.join(cacheNamespace, 'thumb.jpg'), 'c'.repeat(19)],
      [path.join(inspiration, 'reference.jpg'), 'r'.repeat(31)],
      [path.join(workspaceData, 'internal.json'), 'i'.repeat(23)],
      [database, 'd'.repeat(29)],
    ];
    await Promise.all(files.map(([filePath, content]) => fs.promises.writeFile(filePath, content)));
    await fs.promises.writeFile(path.join(foreignCacheNamespace, 'foreign-thumb.jpg'), 'x'.repeat(101));
    const tasks = [];
    let pending;
    let scanRuns = 0;
    const backgroundTasks = {
      list: () => tasks,
      run: (definition, worker) => {
        scanRuns += 1;
        const task = { id: 'scan', type: definition.type, state: 'running', createdAt: Date.now() };
        tasks.push(task);
        pending = (async () => {
          const result = await worker({ throwIfCancelled() {}, report() {} });
          task.state = 'completed';
          return { task, result };
        })();
        return pending;
      },
    };
    const config = {
      workspacePath: workspace,
      workspacePaths: [workspace, secondaryWorkspace],
      archive: { targetPath: archive },
      backup: { targetPath: backup },
      mediaCache: { directory: cache },
      inspirationLibrary: { rootPath: inspiration },
    };
    const eventBus = new EventEmitter();
    const service = createStorageUsageService({
      app: { getPath: name => name === 'userData' ? userData : root },
      backgroundTasks,
      eventBus,
      getWorkspaceDatabasePath: () => database,
      getWorkspaceDataRoot: () => workspaceData,
      readSavedConfig: () => config,
      resolveMediaCacheDirectory: cacheConfig => resolveMediaCacheNamespace({ path, userDataPath: userData, installationId, configuredDirectory: cacheConfig.directory }),
      writeLog() {},
    });
    const initial = await service.overview(false);
    assert.equal(initial.success, true);
    assert.equal(initial.scanning, true);
    await pending;
    const measured = await service.overview(false);
    const items = measured.volumes.flatMap(volume => volume.items);
    assert.equal(measured.scanning, false);
    assert.equal(items.length, 8);
    assert.equal(items.filter(item => item.kind === 'workspace').length, 2);
    assert.equal(items.find(item => item.kind === 'inspiration')?.path, inspiration);
    assert.equal(items.find(item => item.kind === 'cache')?.path, cacheNamespace, 'storage usage must scan only this installation namespace');
    assert.equal(items.every(item => item.measured), true);
    const rolePriority = { workspace: 1, inspiration: 2, cache: 3, internal: 3, archive: 4, backup: 5 };
    assert.equal(items.every((item, index) => index === 0 || rolePriority[items[index - 1].kind] <= rolePriority[item.kind]), true);
    assert.equal(items.reduce((sum, item) => sum + item.bytes, 0), files.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0));
    await fs.promises.appendFile(path.join(cacheNamespace, 'thumb.jpg'), 'changed');
    eventBus.emit('background-task:changed', {
      revision: 1,
      upserts: [{ id: 'cache-cleanup', type: 'cache-cleanup', state: 'completed' }],
      removeIds: [],
    });
    const invalidated = await service.overview(false);
    assert.equal(invalidated.scanning, true, 'completed invalidating tasks delivered as deltas must refresh cached storage usage');
    await pending;
    const refreshed = await service.overview(false);
    assert(refreshed.volumes.flatMap(volume => volume.items).reduce((sum, item) => sum + item.bytes, 0) > items.reduce((sum, item) => sum + item.bytes, 0));
    const cachePath = path.join(userData, 'storage-usage-cache.json');
    const malformedCache = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
    malformedCache.updatedAt = 'not-a-time';
    await fs.promises.writeFile(cachePath, JSON.stringify(malformedCache), 'utf8');
    const runsBeforeMalformedCache = scanRuns;
    assert.equal((await service.overview(false)).scanning, true, 'invalid cache fields must be rejected and remeasured');
    await pending;
    assert.equal(scanRuns, runsBeforeMalformedCache + 1);
    const offlineInspiration = `${inspiration}-offline`;
    await fs.promises.rename(inspiration, offlineInspiration);
    const runsBeforeOffline = scanRuns;
    assert.equal((await service.overview(false)).scanning, true, 'offline transition triggers one immediate refresh');
    await pending;
    const offlineOverview = await service.overview(false);
    assert.equal(offlineOverview.stale, true, 'offline measurements are never reported as fresh success');
    assert.equal(offlineOverview.scanning, false, 'offline retry backoff prevents a hot scan loop');
    await service.overview(false);
    assert.equal(scanRuns, runsBeforeOffline + 1, 'consecutive overview calls start only one offline scan inside the backoff window');
    await fs.promises.rename(offlineInspiration, inspiration);
    assert.equal((await service.overview(false)).scanning, true, 'online transition bypasses offline backoff immediately');
    assert.equal(scanRuns, runsBeforeOffline + 2);
    await pending;
    console.log('Storage usage service integration tests passed.');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
