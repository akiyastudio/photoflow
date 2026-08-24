const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { registerVersionIpc } = require('../electron/modules/versions-ipc.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const componentRenderer = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'legacy-main.tsx'), 'utf8')
  + fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'legacy', 'PersonIdentityManager.tsx'), 'utf8')
  + fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'legacy', 'TeamRetouchOutputProgress.tsx'), 'utf8')
  + fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'legacy', 'useTeamOutputProgress.ts'), 'utf8')
  + fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'legacy', 'legacy-api.ts'), 'utf8');
const interactionModel = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'interaction-model.ts'), 'utf8');
assert(interactionModel.includes("folder.mediaKind === 'image'") && interactionModel.includes('!folder.folderMissing') && interactionModel.includes("folder.nodeRole === 'progress'"), 'component merge targets must be existing image progress nodes');
assert(componentRenderer.includes('legacyApi.getProgressFolders') && componentRenderer.includes('legacyApi.registerProgressWithGraph') && componentRenderer.includes("ok('team.progress.list.v1')") && componentRenderer.includes("ok('team.progress.create.v1'"), 'the active renderer must call only its component-owned progress RPC boundary through the compatibility adapter');
assert(!componentRenderer.includes('project.progress.') && !componentRenderer.includes('createVersionGraphEdge'), 'the renderer must not call host progress capabilities or assemble graph edges directly');

const verifyServiceProgressBoundary = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'extensions', 'team-retouch', 'service.cjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const capabilityCalls = [];
  let nextRequestId = 1;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', code => {
    if (code && pending.size) reject(new Error(`team-retouch service exited ${code}: ${stderr}`));
  });
  const request = (method, payload = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = `request-${nextRequestId++}`;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload })}\n`);
  });
  lines.on('line', line => {
    let frame;
    try { frame = JSON.parse(line); } catch (error) { reject(error); return; }
    if (frame.type === 'ready') {
      void (async () => {
        const listed = await request('team.progress.list.v1');
        assert.deepEqual(listed, { success: true, progressFolders: [{ id: 'original', nodeRole: 'original' }], graphEdges: [{ sourceProgressId: 'source', targetProgressId: 'target' }], edges: [{ sourceProgressId: 'source', targetProgressId: 'target' }] });
        const created = await request('team.progress.create.v1', {
          progress: { mediaKind: 'image', displayName: 'Output' }, workflowInputProgressIds: ['workflow', 'selection'],
        });
        assert.equal(created.progressFolder.id, 'output');
        assert.deepEqual(capabilityCalls.map(call => call.method), ['project.progress.v2', 'project.progress.v2', 'project.progress.v2']);
        assert.deepEqual(capabilityCalls.map(call => call.payload.action), ['list', 'list', 'create']);
        assert.deepEqual(capabilityCalls[2].payload.sourceProgressIds, ['workflow', 'selection']);
        assert.equal(capabilityCalls.some(call => call.method === 'project.progress.list.v1' || call.method === 'workspace-version-graph-edge-create' || call.payload?.action === 'createVersionGraphEdge'), false, 'service must not use Host V1 progress or direct edge creation');
        child.kill();
        resolve();
      })().catch(error => { child.kill(); reject(error); });
      return;
    }
    if (frame.type === 'capability') {
      capabilityCalls.push({ method: frame.method, payload: frame.payload });
      let result;
      if (frame.payload.action === 'list') result = { progress: [{ id: 'original', nodeRole: 'original' }], edges: [{ sourceProgressId: 'source', targetProgressId: 'target' }] };
      else if (frame.payload.action === 'create') result = { progress: { id: 'output' }, edges: [{ sourceProgressId: 'workflow', targetProgressId: 'output' }] };
      else { reject(new Error(`unexpected capability action: ${frame.payload.action}`)); return; }
      child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: true, result })}\n`);
      return;
    }
    if (frame.type === 'response') {
      const target = pending.get(frame.id);
      pending.delete(frame.id);
      if (!target) return;
      frame.ok ? target.resolve(frame.result) : target.reject(new Error(frame.error));
    }
  });
});

const dagResult = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'test-version-tree-dag-layout.cjs')], { encoding: 'utf8' });
assert.equal(dagResult.status, 0, dagResult.stderr || dagResult.stdout);

const python = process.env.PYTHON || (process.platform === 'win32'
  ? path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe') : 'python3');
const databaseProgram = String.raw`
import json, os, sys, tempfile, time, uuid
sys.path.insert(0, os.path.join(sys.argv[1], 'python'))
import workspace_db

with tempfile.TemporaryDirectory() as root:
    db = workspace_db.connect(root, os.path.join(root, 'workspace.db'))
    now = int(time.time() * 1000)
    project_id = str(uuid.uuid4())
    project = os.path.join(root, 'Project')
    os.makedirs(project)
    db.execute("INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)", (project_id, 'Project', 'active', 'Project', now, now))
    db.commit()
    def register(name, role='progress', parent=None, relation=None, artifact=None, source_metadata=None):
        target = os.path.join(project, name)
        os.makedirs(target, exist_ok=True)
        return workspace_db.progress_register(root, db, {
            'projectName':'Project', 'mediaKind':'image', 'versionKey':name,
            'displayName':name, 'folderPath':target, 'nodeRole':role,
            'parentProgressId':parent, 'relationKind':relation, 'artifactKind':artifact,
            'sourceMetadata':source_metadata,
            'trackingEnabled':False, 'trackingState':'disabled',
        })['progressFolder']
    source_one = register('source-one', 'original')
    source_two = register('source-two', 'progress', source_one['id'], 'main')
    selection = register('selection', 'selection', source_one['id'], 'auxiliary')
    artifact = register('artifact', 'artifact', artifact='preview')
    workflow = register('vendor-workflow', 'workflow', artifact='vendor.workflow', source_metadata={
        'category':'workflow', 'componentId':'vendor', 'parentCapability':'workflow-input',
    })

    inputs = workspace_db.progress_register_with_graph(root, db, {
        'projectName':'Project', 'progress':{'progressId':workflow['id']},
        'workflowInputProgressIds':[source_two['id']],
    })
    assert len(inputs['edges']) == 1
    workspace_db.progress_register_with_graph(root, db, {
        'projectName':'Project', 'progress':{'progressId':workflow['id']},
        'workflowInputProgressIds':[source_two['id']],
    })
    assert db.execute("SELECT COUNT(*) FROM progress_folders WHERE node_role='workflow'").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE target_progress_id=?", (workflow['id'],)).fetchone()[0] == 1
    try:
        workspace_db.progress_register_with_graph(root, db, {
            'projectName':'Project', 'progress':{'progressId':workflow['id']},
            'workflowInputProgressIds':[source_one['id']],
        })
        raise AssertionError('original/JPG source accepted as a team workflow input')
    except ValueError as error:
        assert 'progress_graph_input_invalid' in str(error)

    output_one_path = os.path.join(project, 'output-one'); os.makedirs(output_one_path)
    output_one = workspace_db.progress_register_with_graph(root, db, {
        'projectName':'Project',
        'progress':{'mediaKind':'image','versionKey':'10','displayName':'output-one','folderPath':output_one_path,'parentProgressId':source_two['id']},
        'workflowInputProgressIds':[workflow['id']],
    })['progressFolder']
    output_two = register('output-two', 'progress', source_one['id'], 'main')
    assert db.execute("SELECT parent_progress_id FROM progress_folders WHERE id=?", (output_one['id'],)).fetchone()[0] == source_two['id']
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE source_progress_id=? AND target_progress_id=?", (workflow['id'], output_one['id'])).fetchone()[0] == 1

    for invalid in (selection, artifact):
        try:
            workspace_db.progress_register_with_graph(root, db, {'projectName':'Project','progress':{'progressId':invalid['id']},'workflowInputProgressIds':[workflow['id']]})
            raise AssertionError('invalid target accepted')
        except ValueError:
            pass
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE source_progress_id=? AND target_progress_id=?", (workflow['id'], output_one['id'])).fetchone()[0] == 1

    workspace_db.progress_register_with_graph(root, db, {'projectName':'Project','progress':{'progressId':output_two['id']},'workflowInputProgressIds':[workflow['id']]})
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE source_progress_id=? AND target_progress_id=?", (workflow['id'], output_one['id'])).fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE source_progress_id=? AND target_progress_id=?", (workflow['id'], output_two['id'])).fetchone()[0] == 1
    assert db.execute("SELECT parent_progress_id FROM progress_folders WHERE id=?", (output_two['id'],)).fetchone()[0] == source_one['id']

    updated_output = workspace_db.progress_register_with_graph(root, db, {
        'projectName':'Project',
        'progress':{
            'progressId':output_one['id'], 'mediaKind':'image', 'versionKey':'11',
            'displayName':'output-one-updated', 'folderPath':output_one_path,
            'parentProgressId':source_one['id'], 'relationKind':'main',
            'trackingEnabled':True, 'trackingState':'pending_compare',
            'renameFromParent':True, 'copyMissingFromParent':True,
        },
        'workflowInputProgressIds':[selection['id']],
    })['progressFolder']
    assert updated_output['versionKey'] == '11' and updated_output['parentProgressId'] == source_one['id']
    assert updated_output['trackingState'] == 'stale'
    assert updated_output['renameFromParent'] and updated_output['copyMissingFromParent']
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE source_progress_id=? AND target_progress_id=?", (selection['id'], output_one['id'])).fetchone()[0] == 1
    before_invalid = tuple(db.execute("SELECT version_key,parent_progress_id,tracking_state,rename_from_parent,copy_missing_from_parent FROM progress_folders WHERE id=?", (output_one['id'],)).fetchone())
    try:
        workspace_db.progress_register_with_graph(root, db, {
            'projectName':'Project',
            'progress':{
                'progressId':output_one['id'], 'mediaKind':'image', 'versionKey':'12',
                'displayName':'must-rollback', 'folderPath':output_one_path,
                'parentProgressId':source_two['id'], 'relationKind':'main',
                'trackingEnabled':False, 'trackingState':'disabled',
            },
            'workflowInputProgressIds':[artifact['id']],
        })
        raise AssertionError('artifact input accepted for a main progress')
    except ValueError as error:
        assert 'progress_graph_input_invalid' in str(error)
    after_invalid = tuple(db.execute("SELECT version_key,parent_progress_id,tracking_state,rename_from_parent,copy_missing_from_parent FROM progress_folders WHERE id=?", (output_one['id'],)).fetchone())
    assert after_invalid == before_invalid
    assert db.execute("SELECT COUNT(*) FROM version_graph_edges WHERE source_progress_id=? AND target_progress_id=?", (selection['id'], output_one['id'])).fetchone()[0] == 1

    failed_path = os.path.join(project, 'failed-output'); os.makedirs(failed_path)
    db.execute("CREATE TRIGGER fail_team_relation BEFORE INSERT ON version_graph_edges BEGIN SELECT RAISE(ABORT,'forced team relation failure'); END")
    try:
        workspace_db.progress_register_with_graph(root, db, {
            'projectName':'Project',
            'progress':{'mediaKind':'image','versionKey':'99','displayName':'failed-output','folderPath':failed_path,'parentProgressId':source_two['id']},
            'workflowInputProgressIds':[workflow['id']],
        })
        raise AssertionError('forced relation failure accepted')
    except Exception as error:
        assert 'forced team relation failure' in str(error)
    assert db.execute("SELECT COUNT(*) FROM progress_folders WHERE version_key='99'").fetchone()[0] == 0

    db.close()

with tempfile.TemporaryDirectory() as compatibility_root:
    compatibility_db = workspace_db.connect(compatibility_root, os.path.join(compatibility_root, 'workspace.db'))
    compatibility_now = int(time.time() * 1000)
    compatibility_project_id = str(uuid.uuid4())
    compatibility_project = os.path.join(compatibility_root, 'LegacyProject')
    compatibility_workflow = os.path.join(compatibility_project, '团片协作')
    os.makedirs(compatibility_workflow)
    compatibility_db.execute("INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)", (compatibility_project_id, 'LegacyProject', 'active', 'LegacyProject', compatibility_now, compatibility_now))
    compatibility_db.commit()
    legacy = workspace_db.progress_register(compatibility_root, compatibility_db, {
        'projectName':'LegacyProject', 'mediaKind':'image', 'versionKey':'team-workspace',
        'displayName':'团片协作', 'folderPath':compatibility_workflow, 'nodeRole':'workflow',
        'artifactKind':'team_workspace', 'trackingEnabled':False, 'trackingState':'disabled',
    })['progressFolder']
    compatibility_db.execute("UPDATE progress_folders SET source_metadata_json='{}' WHERE id=?", (legacy['id'],))
    from compatibility.team_retouch_v1 import workspace as team_v1_compatibility
    team_v1_compatibility.migrate(compatibility_db, 32)
    metadata = json.loads(compatibility_db.execute("SELECT source_metadata_json FROM progress_folders WHERE id=?", (legacy['id'],)).fetchone()[0])
    assert metadata['category'] == 'workflow' and metadata['componentId'] == 'team-retouch'
    compatibility_db.close()
print('database graph checks passed')
`;
const databaseResult = spawnSync(python, ['-c', databaseProgram, repositoryRoot], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
assert.equal(databaseResult.status, 0, databaseResult.stderr || databaseResult.stdout);

let bridgedApi;
const originalModuleLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return {
    contextBridge: { exposeInMainWorld: (_name, api) => { bridgedApi = api; } },
    ipcRenderer: { invoke: (...args) => Promise.resolve(args), send: () => undefined, on: () => undefined, removeListener: () => undefined },
    webUtils: { getPathForFile: file => file?.path || '' },
  };
  return originalModuleLoad.call(this, request, parent, isMain);
};
try {
  delete require.cache[require.resolve('../electron/preload.cjs')];
  require('../electron/preload.cjs');
} finally {
  Module._load = originalModuleLoad;
}
assert(bridgedApi, 'preload must expose the Electron API');

const ipcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-team-graph-ipc-'));
const projectPath = path.join(ipcRoot, 'Project');
fs.mkdirSync(projectPath);
const handlers = new Map();
let repositoryPayload;
let failCommit = 'empty';
const sourceNode = { id: 'source', nodeRole: 'original', mediaKind: 'image', folderMissing: false, displayName: 'source', folderPath: path.join(projectPath, 'source') };
const selectionNode = { id: 'selection', nodeRole: 'selection', mediaKind: 'image', folderMissing: false, displayName: 'selection', folderPath: path.join(projectPath, 'selection') };
const workflowNode = { id: 'workflow', nodeRole: 'workflow', mediaKind: 'image', folderMissing: false, displayName: 'workflow', folderPath: path.join(projectPath, 'workflow') };
let listedProgressFolders = [sourceNode, selectionNode, workflowNode];
registerVersionIpc({
  Array, Boolean, Date, Error, JSON, Math, Number, Object, Promise, Set, String, undefined,
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  ensureWorkspace: value => value,
  workspaceCatalogs: new Map([[ipcRoot, {}]]),
  refreshWorkspaceCatalog: async () => undefined,
  getProjectPath: () => projectPath,
  suppressWorkspaceWatchPath: () => undefined,
  releaseWorkspaceWatchPath: () => undefined,
  resolveProjectEntry: (_workspacePath, _status, _projectName, relativePath) => {
    const resolved = path.resolve(projectPath, String(relativePath || ''));
    const relative = path.relative(projectPath, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe project-relative path');
    return resolved;
  },
  fs, path,
  projectVirtualPaths: {
    resolve: (root, relativePath) => ({
      projectRoot: path.resolve(root),
      virtualPath: String(relativePath || '').replace(/\\/g, '/'),
      physicalPath: path.resolve(root, String(relativePath || '')),
      mediaRoot: path.resolve(root),
      viaExternalLink: false,
      isExternalLinkRoot: false,
      writable: true,
      offline: false,
    }),
  },
  versionService: {
    listProgress: async () => ({ success: true, progressFolders: listedProgressFolders }),
    registerProgressWithGraph: async (_root, payload) => {
      repositoryPayload = payload;
      if (failCommit === 'nonempty') fs.writeFileSync(path.join(payload.progress.folderPath, 'preserve.txt'), 'created during failed operation');
      if (failCommit) throw new Error('simulated graph failure');
      const existingPath = listedProgressFolders.find(folder => folder.id === payload.progress.progressId)?.folderPath;
      return { success: true, progressFolder: { id: payload.progress.progressId || 'output', folderPath: payload.progress.folderPath || existingPath || projectPath } };
    },
  },
  writeLog: () => undefined,
});
const atomicHandler = handlers.get('workspace-progress-register-with-graph');
assert.equal(typeof atomicHandler, 'function');
(async () => {
  await verifyServiceProgressBoundary();
  const bridgeRequest = {
    projectName: 'Project',
    progress: {
      progressId: 'existing', relativePath: 'nested/existing', mediaKind: 'image', versionKey: '2',
      parentProgressId: 'source', displayName: 'existing', trackingEnabled: true,
      trackingState: 'pending_compare', renameFromParent: true, copyMissingFromParent: true, moveToRoot: true,
    },
    workflowInputProgressIds: ['selection'],
  };
  const bridgeInvocation = await bridgedApi.registerProgressWithGraph(ipcRoot, 'active', bridgeRequest);
  assert.equal(bridgeInvocation[0], 'workspace-progress-register-with-graph');
  assert.deepEqual(bridgeInvocation[3], bridgeRequest, 'preload must preserve every trusted progress policy field while rejecting absolute paths at the main-process boundary');
  const idOnlyBridgeInvocation = await bridgedApi.registerProgressWithGraph(ipcRoot, 'active', {
    projectName: 'Project', progress: { progressId: 'workflow' }, workflowInputProgressIds: ['source'],
  });
  assert.deepEqual(idOnlyBridgeInvocation[3].progress, { progressId: 'workflow' }, 'preload must omit undefined optional fields so an ID-only relation update is not mistaken for new progress creation');

  const request = { projectName: 'Project', progress: { mediaKind: 'image', versionKey: '3', displayName: 'output-three', parentProgressId: 'source' }, workflowInputProgressIds: ['workflow'] };
  let result = await atomicHandler(null, ipcRoot, 'active', request);
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(path.join(projectPath, 'output-three')), false, 'database failure must remove only the newly-created empty directory');
  failCommit = 'nonempty';
  const nonemptyRequest = { ...request, progress: { ...request.progress, versionKey: '4', displayName: 'output-four' } };
  result = await atomicHandler(null, ipcRoot, 'active', nonemptyRequest);
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(path.join(projectPath, 'output-four', 'preserve.txt')), true, 'failed work must not delete a non-empty directory');
  failCommit = false;
  result = await atomicHandler(null, ipcRoot, 'active', request);
  assert.equal(result.success, true, result.error);
  assert.equal(repositoryPayload.progress.nodeRole, undefined);
  assert.equal(repositoryPayload.progress.edgeKind, undefined);
  assert.equal(repositoryPayload.progress.relationKind, 'main', 'main process must derive the structural relation');
  assert.equal(repositoryPayload.progress.folderPath, path.join(projectPath, 'output-three'), 'the main process must author the project path');
  const adoptedPath = path.join(projectPath, 'nested', 'existing');
  fs.mkdirSync(adoptedPath, { recursive: true });
  const adoptedRequest = {
    projectName: 'Project',
    progress: {
      relativePath: 'nested/existing', mediaKind: 'image', versionKey: '5', displayName: 'adopted',
      parentProgressId: 'source', trackingEnabled: true, trackingState: 'pending_compare',
      renameFromParent: true, copyMissingFromParent: true,
    },
    workflowInputProgressIds: ['selection'],
  };
  result = await atomicHandler(null, ipcRoot, 'active', adoptedRequest);
  assert.equal(result.success, true, result.error);
  assert.equal(repositoryPayload.progress.folderPath, adoptedPath, 'main must resolve project-relative adoption paths');
  assert.equal(repositoryPayload.progress.trackingEnabled, true);
  assert.equal(repositoryPayload.progress.trackingState, 'pending_compare');
  assert.equal(repositoryPayload.progress.renameFromParent, true);
  assert.equal(repositoryPayload.progress.copyMissingFromParent, true);
  assert.equal(result.relativePath, 'nested/existing');
  listedProgressFolders = [{ ...workflowNode, folderPath: adoptedPath }];
  result = await atomicHandler(null, ipcRoot, 'active', {
    projectName: 'Project',
    progress: { progressId: 'workflow', mediaKind: undefined, versionKey: undefined, displayName: undefined },
    workflowInputProgressIds: ['source'],
  });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(repositoryPayload.progress, { progressId: 'workflow' }, 'main must treat undefined optional fields as absent during an ID-only relation update');
  const moveSource = path.join(projectPath, 'nested', 'move-me');
  fs.mkdirSync(moveSource, { recursive: true });
  listedProgressFolders = [sourceNode, { id: 'move-existing', nodeRole: 'progress', mediaKind: 'image', parentProgressId: 'source', relationKind: 'main', folderPath: moveSource, folderMissing: false }];
  const moveRequest = {
    projectName: 'Project',
    progress: {
      progressId: 'move-existing', relativePath: 'nested/move-me', mediaKind: 'image', versionKey: '6', displayName: 'move-me',
      parentProgressId: 'source', trackingEnabled: false, trackingState: 'disabled', moveToRoot: true,
    },
    workflowInputProgressIds: [],
  };
  failCommit = 'empty';
  result = await atomicHandler(null, ipcRoot, 'active', moveRequest);
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(moveSource), true, 'database failure must move an adopted nested folder back to its original location');
  assert.equal(fs.existsSync(path.join(projectPath, 'move-me')), false, 'failed root adoption must not leave a duplicate root folder');
  failCommit = false;
  result = await atomicHandler(null, ipcRoot, 'active', moveRequest);
  assert.equal(result.success, true, result.error);
  assert.equal(result.relativePath, 'move-me');
  assert.equal(fs.existsSync(path.join(projectPath, 'move-me')), true);
  assert.equal(repositoryPayload.progress.folderPath, path.join(projectPath, 'move-me'));
  const escaped = await atomicHandler(null, ipcRoot, 'active', { ...adoptedRequest, progress: { ...adoptedRequest.progress, relativePath: '../outside' } });
  assert.equal(escaped.success, false, 'renderer must not escape the registered project with a relative path');
  const rejected = await atomicHandler(null, ipcRoot, 'active', { ...request, progress: { ...request.progress, nodeRole: 'selection', folderPath: 'C:\\outside', edgeKind: 'workflow_input' } });
  assert.equal(rejected.success, false, 'renderer graph semantics must be rejected');
  listedProgressFolders = [sourceNode];
  const missingParent = await atomicHandler(null, ipcRoot, 'active', {
    projectName: 'Project', progress: { mediaKind: 'image', versionKey: '7', displayName: 'missing-parent' }, workflowInputProgressIds: [],
  });
  assert.equal(missingParent.success, false);
  assert.match(missingParent.error, /新进度字段无效|parent/);
  fs.rmSync(ipcRoot, { recursive: true, force: true });
  console.log('team workflow version graph tests passed');
})().catch(error => { fs.rmSync(ipcRoot, { recursive: true, force: true }); console.error(error); process.exitCode = 1; });
