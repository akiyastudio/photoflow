const assert = require('assert');
const path = require('path');
const { registerVersionIpc } = require('../electron/modules/versions-ipc.cjs');

(async () => {
  const handlers = new Map();
  const workspaceRoot = 'trusted-workspace-root';
  const child = { id: 'child', nodeRole: 'progress' };
  const parent = { id: 'parent', nodeRole: 'original' };
  let repositoryPayload;
  let repairPayload;
  let layoutGetPayload;
  let layoutSavePayload;
  let edgeReplacePayload;
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
    versionService: {
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
  layoutSavePayload = undefined;
  const foreignLayout = await layoutSaveHandler(null, workspaceRoot, 'Trusted Project', {
    scopeKey: '', expectedRevision: 0, mode: 'patch', positions: [{ nodeKey: 'progress:foreign', x: 0, y: 0 }],
  });
  assert.strictEqual(foreignLayout.success, false);
  assert.match(foreignLayout.error, /version_tree_layout_node_invalid/);
  assert.strictEqual(layoutSavePayload, undefined);
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
    resolveProjectEntry: (_workspace, _status, projectName, relativePath) => {
      assert.strictEqual(projectName, 'Trusted Project');
      if (path.isAbsolute(relativePath) || relativePath.includes('..')) throw new Error('项目路径越界');
      return path.join('C:\\trusted-project', ...relativePath.split('/'));
    },
    fs: { statSync: () => ({ isDirectory: () => true }) },
    versionService: {
      listProgress: async () => ({ progressFolders: [parent] }),
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
