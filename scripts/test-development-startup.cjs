const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareDevelopmentPython } = require('./prepare-development-python.cjs');
const { createWorkspaceService } = require('../electron/services/workspace-service.cjs');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');

const run = async () => {
  const events = [];
  assert.equal(prepareDevelopmentPython({
    resolvePython: () => 'ready-python',
    setupPython: () => assert.fail('valid environments must not reinstall dependencies'),
  }), 'ready-python');
  let ready = false;
  assert.equal(prepareDevelopmentPython({
    resolvePython: () => { events.push('validate'); if (!ready) throw new Error('missing packaging'); return 'repaired-python'; },
    setupPython: () => { events.push('setup'); ready = true; },
    log: () => undefined,
  }), 'repaired-python');
  assert.deepEqual(events, ['validate', 'setup', 'validate']);
  assert.throws(() => prepareDevelopmentPython({
    resolvePython: () => { throw new Error('missing packaging'); },
    setupPython: () => { throw new Error('installation failed'); },
    log: () => undefined,
  }), /installation failed/, 'failed setup must stop startup');
  assert.throws(() => prepareDevelopmentPython({
    resolvePython: () => { throw new Error('still incomplete'); },
    setupPython: () => undefined,
    log: () => undefined,
  }), /still incomplete/, 'startup must revalidate after setup');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-development-startup-'));
  try {
    const projectName = 'Restored project';
    const projectRoot = path.join(root, projectName);
    fs.mkdirSync(path.join(projectRoot, 'Photos'), { recursive: true });
    const catalogs = new Map();
    let releaseLoad;
    let loadCount = 0;
    let rejectLoad = false;
    const service = createWorkspaceService({
      catalogs,
      repository: { load: async () => {
        loadCount += 1;
        if (rejectLoad) throw new Error('Python environment unavailable');
        await new Promise(resolve => { releaseLoad = resolve; });
        return { projects: [{ name: projectName, status: 'active', relative_path: projectName }] };
      } },
      assertInside: (base, candidate) => {
        const relative = path.relative(base, candidate);
        assert(!relative.startsWith('..') && !path.isAbsolute(relative));
        return candidate;
      },
      assertExistingInside: (_base, candidate) => candidate,
    });
    const handlers = new Map();
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Number, Object, Promise, Set, String,
      fs, path, workspaceCatalogs: catalogs, activeProjectFileOperations: new Map(),
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getProjectPath: service.getProjectPath, getReadyProjectPath: service.getReadyProjectPath,
      ensureWorkspace: service.ensureRoot, writeLog: () => undefined,
      HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(),
    });
    assert.throws(() => service.getProjectPath(root, 'active', projectName), /未在当前工作区注册/);
    const restoredTab = handlers.get('workspace-project-contents')({}, root, 'active', projectName);
    const simultaneousLookup = service.getReadyProjectPath(root, 'active', projectName);
    assert.equal(loadCount, 1, 'restored tabs must share one initial catalog load');
    releaseLoad();
    const contents = await restoredTab;
    assert.equal(contents.success, true, contents.error);
    assert.deepEqual(contents.folders.map(folder => folder.name), ['Photos']);
    assert.equal(await simultaneousLookup, projectRoot);
    assert.equal(await service.getReadyProjectPath(root, 'active', projectName), projectRoot);
    assert.equal(loadCount, 1, 'warm reads must use the loaded catalog');
    await assert.rejects(service.getReadyProjectPath(root, 'active', 'Unknown'), /未在当前工作区注册/);
    await assert.rejects(service.getReadyProjectPath(root, 'wrong-status', projectName), /项目状态与目录记录不一致/);

    catalogs.clear();
    rejectLoad = true;
    const failedRead = await handlers.get('workspace-project-contents')({}, root, 'active', projectName);
    assert.equal(failedRead.success, false);
    assert.match(failedRead.error, /Python environment unavailable/, 'preserve the real load failure instead of misreporting an unregistered project');
    rejectLoad = false;
    const retry = service.getReadyProjectPath(root, 'active', projectName);
    releaseLoad();
    assert.equal(await retry, projectRoot, 'failed initial loads must remain retryable');
    assert.equal(loadCount, 3);
    await assert.rejects(service.getReadyProjectPath(root, 'active', '.__photoflow_inspiration__'), /尚未配置灵感库文件夹/);
    assert.equal(loadCount, 3, 'inspiration authorization must not load a workspace catalog');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Development startup: dependency repair, restored project hydration, authorization and retry tests passed.');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
