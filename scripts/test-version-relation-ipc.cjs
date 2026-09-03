const assert = require('assert');
const path = require('path');
const { registerVersionIpc } = require('../electron/modules/versions-ipc.cjs');

(async () => {
  const handlers = new Map();
  const workspaceRoot = 'trusted-workspace-root';
  const child = { id: 'child', nodeRole: 'progress' };
  const parent = { id: 'parent', nodeRole: 'original', mediaKind: 'image', folderMissing: false };
  const videoParent = { id: 'video-parent', nodeRole: 'original', mediaKind: 'video', folderMissing: false };
  let repositoryPayload;
  let repairPayload;
  let layoutGetPayload;
  let layoutSavePayload;
  let layoutSaveAttempts = 0;
  let layoutLockFailures = 0;
  let snapshotProgressCalls = 0;
  let locationSnapshotCalls = 0;
  let edgeReplacePayload;
  let unregisterPayload;
  let filesystemCalls = 0;
  const failFilesystem = new Proxy({}, { get() { filesystemCalls += 1; throw new Error('relation IPC must not access files'); } });
  registerVersionIpc({
    Array, Boolean, Error, JSON, Math, Number, Set, String, undefined,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    ensureWorkspace: value => {
      assert.strictEqual(value, workspaceRoot, 'workspace authorization must use the outer trusted context argument');
      return workspaceRoot;
    },
    workspaceCatalogs: new Map([[workspaceRoot, { projects: [{ name: 'Trusted Project' }] }]]),
    refreshWorkspaceCatalog: async () => { throw new Error('catalog should already be loaded'); },
    getProjectPath: () => 'C:\\trusted-project',
    projectVirtualPaths: {
      resolve: (_root, relativePath) => {
        if (path.isAbsolute(relativePath) || String(relativePath).includes('..')) throw new Error('项目路径越界');
        return relativePath === 'RAW.lnk'
          ? { physicalPath: path.resolve('D:\\external-originals'), virtualPath: 'RAW.lnk', viaExternalLink: true, externalTargetKind: 'folder' }
          : { physicalPath: path.join('C:\\trusted-project', ...String(relativePath).split('/')), virtualPath: String(relativePath), viaExternalLink: false };
      },
    },
    versionService: {
      snapshotProgress: async (_root, projectName, includeMissing) => {
        assert.strictEqual(projectName, 'Trusted Project');
        assert([undefined, true].includes(includeMissing));
        snapshotProgressCalls += 1;
        return { success: true, progressFolders: [child, parent], graphEdges: [] };
      },
      snapshotProgressLocations: async (_root, projectName, includeMissing) => {
        assert.strictEqual(projectName, 'Trusted Project');
        assert.strictEqual(includeMissing, true, 'the public tree must retain freshly detected missing nodes');
        locationSnapshotCalls += 1;
        return { success: true, progressFolders: [child, parent], graphEdges: [] };
      },
      listProgress: async (_root, projectName, includeMissing) => {
        assert.strictEqual(projectName, 'Trusted Project');
        assert.strictEqual(includeMissing, true);
        return { progressFolders: [child, parent], legacySelectionRelationRepairs: [{ progressId: child.id }] };
      },
      updateProgressRelation: async (root, payload) => {
        assert.strictEqual(root, workspaceRoot);
        repositoryPayload = payload;
        return { success: true, progressFolder: { ...child, parentProgressId: parent.id } };
      },
      unregisterProgress: async (root, payload) => {
        assert.strictEqual(root, workspaceRoot);
        unregisterPayload = payload;
        return { success: true, progressId: payload.progressId };
      },
      repairLegacySelectionRelation: async (root, payload) => {
        assert.strictEqual(root, workspaceRoot);
        repairPayload = payload;
        return { success: true, progressFolder: { ...child, nodeRole: 'selection', parentProgressId: parent.id } };
      },
      getVersionTreeLayout: async (root, payload) => {
        assert.strictEqual(root, workspaceRoot);
        layoutGetPayload = payload;
        return { success: true, revision: 0, positions: [] };
      },
      saveVersionTreeLayout: async (root, payload) => {
        assert.strictEqual(root, workspaceRoot);
        layoutSaveAttempts += 1;
        if (layoutLockFailures > 0) {
          layoutLockFailures -= 1;
          throw Object.assign(new Error('localized busy message'), { code: 'SQLITE_BUSY' });
        }
        layoutSavePayload = payload;
        return { success: true, revision: 1 };
      },
      replaceVersionGraphEdgeSource: async (root, payload) => {
        assert.strictEqual(root, workspaceRoot);
        edgeReplacePayload = payload;
        return { success: true };
      },
    },
    fs: failFilesystem,
    path: failFilesystem,
  });

  const progressFoldersSnapshotHandler = handlers.get('workspace-progress-folders-snapshot');
  assert(progressFoldersSnapshotHandler, 'fast progress snapshots must be registered separately from location reconciliation');
  const progressFoldersSnapshotResult = await progressFoldersSnapshotHandler(null, workspaceRoot, 'Trusted Project');
  assert.strictEqual(progressFoldersSnapshotResult.success, true);
  assert.strictEqual(snapshotProgressCalls, 1, 'the first version-tree paint must use the query-only progress snapshot');
  assert.strictEqual(locationSnapshotCalls, 0, 'the fast snapshot must not perform filesystem location reconciliation');

  const progressFoldersHandler = handlers.get('workspace-progress-folders');
  assert(progressFoldersHandler, 'interactive progress reads must be registered');
  const progressFoldersResult = await progressFoldersHandler(null, workspaceRoot, 'Trusted Project');
  assert.strictEqual(progressFoldersResult.success, true);
  assert.strictEqual(locationSnapshotCalls, 1, 'background reconciliation must still refresh physical progress locations');
  assert.strictEqual(snapshotProgressCalls, 1, 'the location refresh must not replace the separate fast-snapshot call');

  const unregisterHandler = handlers.get('workspace-progress-unregister');
  assert(unregisterHandler, 'progress unregister IPC must be registered');
  const unregisterResult = await unregisterHandler(null, workspaceRoot, 'Trusted Project', child.id);
  assert.strictEqual(unregisterResult.success, true);
  assert.deepStrictEqual(unregisterPayload, { projectName: 'Trusted Project', progressId: child.id }, 'unregister must pass only the trusted project name and progress ID');

  const handler = handlers.get('workspace-progress-relation-update');
  assert(handler, 'relation IPC must be registered');
  const result = await handler(null, workspaceRoot, 'Trusted Project', {
    childProgressId: child.id,
    parentProgressId: parent.id,
    expectedUpdatedAt: 123,
    workspaceRoot: 'attacker-workspace',
    projectName: 'Attacker Project',
    projectPath: 'C:\\outside',
    folderPath: 'C:\\outside\\folder',
    absolutePath: 'C:\\outside\\file',
    relationKind: 'auxiliary',
    nodeRole: 'original',
  });
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(repositoryPayload, {
    childProgressId: child.id,
    parentProgressId: parent.id,
    expectedUpdatedAt: 123,
  }, 'only node IDs and the optional revision may cross the repository boundary');
  assert.strictEqual(filesystemCalls, 0, 'relation updates must not move, overwrite, delete, or inspect files');

  repositoryPayload = undefined;
  const forbiddenDetach = await handler(null, workspaceRoot, 'Trusted Project', {
    childProgressId: child.id, parentProgressId: null,
  });
  assert.strictEqual(forbiddenDetach.success, false);
  assert.match(forbiddenDetach.error, /progress_detach_requires_unregister/);
  assert.strictEqual(repositoryPayload, undefined, 'parentless progress must use the explicit ID-only unregister command');

  const replaceEdgeHandler = handlers.get('workspace-version-graph-edge-replace-source');
  assert(replaceEdgeHandler, 'supplemental edge reconnect IPC must be registered');
  const replaceResult = await replaceEdgeHandler(null, workspaceRoot, {
    projectId: 'project', sourceProgressId: 'old-source', targetProgressId: 'target',
    edgeKind: 'workflow_input', newSourceProgressId: 'new-source', absolutePath: 'C:\\outside',
  });
  assert.strictEqual(replaceResult.success, true);
  assert.deepStrictEqual(edgeReplacePayload, {
    projectId: 'project', sourceProgressId: 'old-source', targetProgressId: 'target',
    edgeKind: 'workflow_input', newSourceProgressId: 'new-source',
  }, 'supplemental edge reconnect must pass only project, node, and relation identifiers');

  repositoryPayload = undefined;
  const rejected = await handler(null, workspaceRoot, 'Trusted Project', { childProgressId: child.id, parentProgressId: 'foreign-parent' });
  assert.strictEqual(rejected.success, false);
  assert.match(rejected.error, /relation_project_mismatch/);
  assert.strictEqual(repositoryPayload, undefined);
  assert.strictEqual(filesystemCalls, 0);

  const repairHandler = handlers.get('workspace-legacy-selection-relation-repair');
  assert(repairHandler, 'legacy selection repair IPC must be registered');
  const repairResult = await repairHandler(null, workspaceRoot, 'Trusted Project', {
    progressId: child.id,
    sourceProgressId: parent.id,
    projectPath: 'C:\\outside',
    folderPath: 'C:\\outside\\folder',
    absolutePath: 'C:\\outside\\file',
    relationKind: 'main',
    nodeRole: 'progress',
  });
  assert.strictEqual(repairResult.success, true);
  assert.deepStrictEqual(repairPayload, { progressId: child.id, sourceProgressId: parent.id }, 'legacy repair IPC must pass only trusted project node IDs');
  assert.strictEqual(filesystemCalls, 0, 'legacy repair IPC must not inspect or mutate physical files');

  repairPayload = undefined;
  const keepIndependent = await repairHandler(null, workspaceRoot, 'Trusted Project', {
    progressId: child.id, action: 'keep-independent', sourceProgressId: 'foreign-source', absolutePath: 'C:\\outside',
  });
  assert.strictEqual(keepIndependent.success, true);
  assert.deepStrictEqual(repairPayload, { progressId: child.id, action: 'keep-independent' }, 'keeping a legacy node independent must not require or forward a source node or filesystem path');

  repairPayload = undefined;
  const foreignRepair = await repairHandler(null, workspaceRoot, 'Trusted Project', { progressId: child.id, sourceProgressId: 'foreign-source' });
  assert.strictEqual(foreignRepair.success, false);
  assert.match(foreignRepair.error, /legacy_selection_repair_project_mismatch/);
  assert.strictEqual(repairPayload, undefined);

  const layoutGetHandler = handlers.get('workspace-version-tree-layout-get');
  const layoutSaveHandler = handlers.get('workspace-version-tree-layout-save');
  assert(layoutGetHandler && layoutSaveHandler, 'version tree layout IPC handlers must be registered');
  assert.strictEqual((await layoutGetHandler(null, workspaceRoot, 'Trusted Project', 'folder/sub')).success, true);
  assert.deepStrictEqual(layoutGetPayload, { projectName: 'Trusted Project', scopeKey: 'folder/sub' });
  layoutGetPayload = undefined;
  const absoluteScope = await layoutGetHandler(null, workspaceRoot, 'Trusted Project', 'C:\\outside');
  assert.strictEqual(absoluteScope.success, false);
  assert.match(absoluteScope.error, /version_tree_scope_invalid/);
  assert.strictEqual(layoutGetPayload, undefined);

  const layoutSaved = await layoutSaveHandler(null, workspaceRoot, 'Trusted Project', {
    scopeKey: '', expectedRevision: 0, mode: 'patch',
    positions: [{ nodeKey: `progress:${child.id}`, x: 12.5, y: -8 }],
    projectPath: 'C:\\outside', absolutePath: 'C:\\outside\\file', folderPath: 'C:\\outside\\folder',
  });
  assert.strictEqual(layoutSaved.success, true);
  assert.deepStrictEqual(layoutSavePayload, {
    projectName: 'Trusted Project', scopeKey: '', expectedRevision: 0, mode: 'patch',
    positions: [{ nodeKey: `progress:${child.id}`, x: 12.5, y: -8 }],
  }, 'layout IPC must pass only the trusted project name, normalized scope, revision, mode, stable node IDs, and finite coordinates');
  layoutLockFailures = 2;
  const attemptsBeforeLockedSave = layoutSaveAttempts;
  const busyLayout = await layoutSaveHandler(null, workspaceRoot, 'Trusted Project', {
    scopeKey: '', expectedRevision: 0, mode: 'patch', positions: [{ nodeKey: `progress:${child.id}`, x: 20, y: 30 }],
  });
  assert.strictEqual(busyLayout.success, false, 'non-idempotent layout writes must not be retried automatically');
  assert.strictEqual(layoutSaveAttempts - attemptsBeforeLockedSave, 1, 'layout save must make one write attempt');
  layoutLockFailures = 0;
  const ordinaryFolderLayout = await layoutSaveHandler(null, workspaceRoot, 'Trusted Project', {
    scopeKey: '', expectedRevision: 1, mode: 'patch', positions: [{ nodeKey: 'entry:other', x: 30, y: 40 }],
  });
  assert.strictEqual(ordinaryFolderLayout.success, true, 'a normalized ordinary-folder node in the current scope must be accepted');
  assert.strictEqual(layoutSavePayload.positions[0].nodeKey, 'entry:other');
  layoutSavePayload = undefined;
  const foreignLayout = await layoutSaveHandler(null, workspaceRoot, 'Trusted Project', {
    scopeKey: '', expectedRevision: 0, mode: 'patch', positions: [{ nodeKey: 'progress:foreign', x: 0, y: 0 }],
  });
  assert.strictEqual(foreignLayout.success, false);
  assert.match(foreignLayout.error, /version_tree_layout_node_invalid/);
  assert.strictEqual(layoutSavePayload, undefined);
  const crossScopeLayout = await layoutSaveHandler(null, workspaceRoot, 'Trusted Project', {
    scopeKey: '', expectedRevision: 1, mode: 'patch', positions: [{ nodeKey: 'entry:folder/other', x: 0, y: 0 }],
  });
  assert.strictEqual(crossScopeLayout.success, false);
  assert.match(crossScopeLayout.error, /version_tree_layout_node_invalid/);
  const invalidCoordinate = await layoutSaveHandler(null, workspaceRoot, 'Trusted Project', {
    scopeKey: '', expectedRevision: 0, mode: 'patch', positions: [{ nodeKey: `progress:${child.id}`, x: Infinity, y: 0 }],
  });
  assert.strictEqual(invalidCoordinate.success, false);
  assert.match(invalidCoordinate.error, /version_tree_layout_coordinate_invalid/);
  assert.strictEqual(filesystemCalls, 0, 'layout IPC must not scan or mutate project files');

  const adoptionHandlers = new Map();
  let adoptionPayload;
  registerVersionIpc({
    Array, Boolean, Error, JSON, Math, Number, Set, String, undefined, path,
    ipcMain: { handle: (channel, registeredHandler) => adoptionHandlers.set(channel, registeredHandler) },
    ensureWorkspace: value => { assert.strictEqual(value, workspaceRoot); return workspaceRoot; },
    workspaceCatalogs: new Map([[workspaceRoot, { projects: [{ name: 'Trusted Project' }] }]]),
    refreshWorkspaceCatalog: async () => { throw new Error('catalog should already be loaded'); },
    getProjectPath: () => 'C:\\trusted-project',
    projectVirtualPaths: {
      resolve: (_root, relativePath) => {
        if (path.isAbsolute(relativePath) || String(relativePath).includes('..')) throw new Error('项目路径越界');
        return relativePath === 'RAW.lnk'
          ? { physicalPath: path.resolve('D:\\external-originals'), virtualPath: 'RAW.lnk', viaExternalLink: true, externalTargetKind: 'folder' }
          : { physicalPath: path.join('C:\\trusted-project', ...String(relativePath).split('/')), virtualPath: String(relativePath), viaExternalLink: false };
      },
    },
    resolveProjectEntry: (_workspace, _status, projectName, relativePath) => {
      assert.strictEqual(projectName, 'Trusted Project');
      if (path.isAbsolute(relativePath) || relativePath.includes('..')) throw new Error('项目路径越界');
      return path.join('C:\\trusted-project', ...relativePath.split('/'));
    },
    fs: {
      statSync: filePath => ({ isDirectory: () => path.extname(filePath).toLowerCase() !== '.lnk', isFile: () => path.extname(filePath).toLowerCase() === '.lnk' }),
      promises: { stat: async () => ({ isDirectory: () => true }) },
    },
    shell: { readShortcutLink: shortcutPath => ({ target: 'D:\\external-originals', description: `PhotoFlow 外链文件夹：${path.basename(shortcutPath, '.lnk')}` }) },
    versionService: {
      listProgress: async () => ({ progressFolders: [parent, videoParent] }),
      adoptMediaFolder: async (root, payload) => { assert.strictEqual(root, workspaceRoot); adoptionPayload = payload; return { success: true, progressFolder: { id: 'adopted' } }; },
    },
  });
  const adoptionHandler = adoptionHandlers.get('workspace-progress-adopt-media');
  assert(adoptionHandler, 'manual media adoption IPC must be registered');
  const absoluteAdoption = await adoptionHandler(null, workspaceRoot, '后期中', {
    projectName: 'Trusted Project', relativePath: 'C:\\outside', mode: 'original', mediaKind: 'image',
  });
  assert.strictEqual(absoluteAdoption.success, false, 'renderer absolute paths must not reach media adoption');
  assert.strictEqual(adoptionPayload, undefined);
  const adopted = await adoptionHandler(null, workspaceRoot, '后期中', {
    projectName: 'Trusted Project', relativePath: 'manual/source', mode: 'preview', mediaKind: 'image',
    sourceProgressId: parent.id,
  });
  assert.strictEqual(adopted.success, true);
  assert.deepStrictEqual(adoptionPayload, {
    projectName: 'Trusted Project', folderPath: path.join('C:\\trusted-project', 'manual', 'source'),
    mode: 'preview', mediaKind: 'image', sourceProgressId: parent.id,
  }, 'repository must receive only the main-process-resolved path and derived adoption fields');
  adoptionPayload = undefined;
  const adoptedTranscode = await adoptionHandler(null, workspaceRoot, '后期中', {
    projectName: 'Trusted Project', relativePath: 'mov_转码', mode: 'transcode', mediaKind: 'video',
    sourceProgressId: videoParent.id,
  });
  assert.strictEqual(adoptedTranscode.success, true);
  assert.deepStrictEqual(adoptionPayload, {
    projectName: 'Trusted Project', folderPath: path.join('C:\\trusted-project', 'mov_转码'),
    mode: 'transcode', mediaKind: 'video', sourceProgressId: videoParent.id,
  }, 'video transcode adoption must preserve the dedicated transcode purpose and source node');
  adoptionPayload = undefined;
  const adoptedExternalOriginal = await adoptionHandler(null, workspaceRoot, '后期中', {
    projectName: 'Trusted Project', relativePath: 'RAW.lnk', mode: 'original', mediaKind: 'image',
  });
  assert.strictEqual(adoptedExternalOriginal.success, true, adoptedExternalOriginal.error);
  assert.deepStrictEqual(adoptionPayload, {
    projectName: 'Trusted Project', folderPath: path.resolve('D:\\external-originals'), externalLinkRelativePath: 'RAW.lnk', mode: 'original', mediaKind: 'image',
  }, 'a managed external folder imported as original material must register its resolved target as an original version-tree node');
  adoptionPayload = undefined;
  const adoptedBroll = await adoptionHandler(null, workspaceRoot, '后期中', {
    projectName: 'Trusted Project', relativePath: 'manual/broll', mode: 'broll', mediaKind: 'mixed',
  });
  assert.strictEqual(adoptedBroll.success, true, adoptedBroll.error);
  assert.deepStrictEqual(adoptionPayload, {
    projectName: 'Trusted Project', folderPath: path.join('C:\\trusted-project', 'manual', 'broll'), mode: 'broll', mediaKind: 'mixed',
  }, 'broll adoption must pass only a main-process-resolved path and the restricted broll/mixed purpose command');
  adoptionPayload = undefined;
  const injectedAdoption = await adoptionHandler(null, workspaceRoot, '后期中', {
    projectName: 'Trusted Project', relativePath: 'manual/source', mode: 'preview', mediaKind: 'image',
    sourceProgressId: parent.id, folderPath: 'C:\\outside', nodeRole: 'progress', edgeKind: 'main',
  });
  assert.strictEqual(injectedAdoption.success, false);
  assert.strictEqual(adoptionPayload, undefined);

  console.log('version relation IPC behavior tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
