const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { normalizeSdImportAutoMove } = require('../electron/modules/system-ipc.cjs');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { MAX_CHANGED_PATHS } = require('../electron/contracts/media-sync-limits.cjs');

const handlers = new Map();
const root = 'trusted-workspace';
const statuses = new Map([
  ['a', '待拍摄'], ['b', '策划中'], ['c', '自定义分类'], ['d', '已归档'],
  ['e', '待拍摄'], ['f', '待拍摄'], ['g', '未分类'], ['h', '待拍摄'], ['i', '待拍摄'],
]);
const names = new Map([...statuses.keys()].map(key => [key, key.toUpperCase()]));
let reconcileCount = 0;
let refreshCount = 0;
let statusUpdates = [];
let scans = [];
let projectEvents = 0;

const catalog = () => ({ projects: [...statuses].map(([key, status]) => ({
  id: `id-${key}`, name: names.get(key), status, relative_path: names.get(key),
})) });
const cleanProjectName = value => /^[A-Za-z]+$/.test(value.trim()) ? value.trim() : '';
const fakeFs = {
  existsSync: value => !String(value).includes('data-root'),
  statSync: () => ({ mtimeMs: 123, isFile: () => true }),
  promises: {},
};

registerWorkspaceIpc({
  Array, Boolean, Date, Error, Math, Object, Promise, Set, String,
  HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(['.jpg']), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(), WORKSPACE_STATUSES: ['未分类', '策划中', '待拍摄', '后期中', '已归档'],
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  ensureWorkspace: value => { assert.strictEqual(value, root); return root; },
  cleanProjectName,
  reconcileWorkspaceCatalog: async () => { reconcileCount += 1; return catalog(); },
  refreshWorkspaceCatalog: async () => { refreshCount += 1; return catalog(); },
  workspaceRepository: {
    setProjectStatus: async (_root, request) => {
      assert.strictEqual(_root, root);
      const key = request.name.toLowerCase();
      statusUpdates.push({ name: request.name, status: request.status });
      if (key === 'f') throw new Error('simulated status failure');
      statuses.set(key, request.status);
    },
  },
  scheduleMediaTrackingScan: (_root, name, changes, fullScan) => { assert.strictEqual(_root, root); scans.push({ root: _root, name, changes, fullScan }); },
  mainWindow: { webContents: { send: channel => { if (channel === 'workspace-projects-changed') projectEvents += 1; } }, },
  fs: fakeFs,
  path,
  crypto,
  getWorkspaceDataRoot: () => 'data-root',
  writeLog: () => undefined,
});

(async () => {
  assert.strictEqual(normalizeSdImportAutoMove(undefined), true, 'old config must default to enabled');
  assert.strictEqual(normalizeSdImportAutoMove('invalid'), true, 'invalid config must retain enabled default');
  assert.strictEqual(normalizeSdImportAutoMove(false), false, 'only explicit false may disable the setting');

  const completionModel = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'tools', 'import-completion-model.ts')).href);
  let completion = completionModel.createImportCompletion();
  completion = completionModel.appendImportSuccess(completion, { sourceType: 'work', projectNames: ['A', 'A'], importedCount: 3, importedPathsByProject: { A: ['C:/workspace/A/one.jpg'] } });
  completion = completionModel.appendImportSuccess(completion, { sourceType: 'broll', projectNames: ['A', 'B'], importedCount: 2, importedPathsByProject: { a: ['C:/workspace/A/one.jpg', 'C:/workspace/A/two.mov'], B: ['C:/workspace/B/three.jpg'] } });
  completion = completionModel.appendImportSuccess(completion, { sourceType: 'work', projectNames: ['C'], importedCount: 0 });
  completion = completionModel.appendImportSuccess(completion, { sourceType: 'work', projectNames: ['D'], importedCount: 9, skipped: true });
  assert.deepStrictEqual(completion.projectNames, ['A', 'B'], 'batch completion project names must be deduplicated from successful events');
  assert.deepStrictEqual(completion.workProjectNames, ['A'], 'only successful work events may identify movable projects');
  assert.deepStrictEqual(completion.brollProjectNames, ['A', 'B'], 'broll projects must remain separately identified');
  assert.strictEqual(completion.importedCount, 5, 'zero and skipped events must not increase imported count');
  assert.deepStrictEqual(completion.importedPathsByProject, { A: ['C:/workspace/A/one.jpg', 'C:/workspace/A/two.mov'], B: ['C:/workspace/B/three.jpg'] });

  const skippedCompletion = completionModel.appendImportSuccess(completionModel.createImportCompletion(), { sourceType: 'work', projectNames: ['A'], importedCount: 0, skipped: true });
  assert.strictEqual(skippedCompletion.skipped, true);
  assert.deepStrictEqual(skippedCompletion.workProjectNames, []);
  const finalize = handlers.get('workspace-finalize-sd-imports');
  assert(finalize, 'finalize SD imports IPC must be registered');

  const importedA = path.resolve(root, 'A', 'imported.jpg');
  let result = await finalize(null, root, ['A'], { moveProjectAfterImport: false, workProjectNames: ['A'], importedPathsByProject: { A: [importedA] } });
  assert.strictEqual(result.success, true);
  assert.strictEqual(statuses.get('a'), '待拍摄', 'disabled setting must keep the project category');
  assert.deepStrictEqual(result.movedProjects, []);
  assert.strictEqual(result.unchangedProjects[0].status, '待拍摄');
  assert.deepStrictEqual(scans[0], { root, name: 'A', changes: [{ path: importedA, eventType: 'rename', kind: 'file' }], fullScan: false }, 'SD finalization must pass all four precise incremental-scan arguments');
  assert(refreshCount > 0 && reconcileCount > 0 && projectEvents > 0, 'disabled setting must still reconcile, refresh, scan, and notify');

  const boundaryPaths = Array.from({ length: MAX_CHANGED_PATHS }, (_, index) => path.resolve(root, 'I', `boundary-${index}.jpg`));
  scans = [];
  result = await finalize(null, root, ['I'], {
    moveProjectAfterImport: false, workProjectNames: ['I'], importedPathsByProject: { I: boundaryPaths },
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(scans.length, 1, 'the exact incremental limit must schedule once');
  assert.deepStrictEqual(scans[0], {
    root, name: 'I', changes: boundaryPaths.map(filePath => ({ path: filePath, eventType: 'rename', kind: 'file' })), fullScan: false,
  }, 'the exact incremental limit must preserve all four scheduler arguments');

  const overflowPaths = [...boundaryPaths, path.resolve(root, 'I', 'overflow.jpg')];
  scans = [];
  result = await finalize(null, root, ['I'], {
    moveProjectAfterImport: true, workProjectNames: ['I'], importedPathsByProject: { I: overflowPaths },
  });
  assert.strictEqual(result.success, true, 'overflow fallback must not fail after moving the project status');
  assert.strictEqual(statuses.get('i'), '后期中');
  assert.deepStrictEqual(scans, [{ root, name: 'I', changes: [], fullScan: true }], 'over-limit imports must schedule exactly one full scan and no partial increment');

  scans = [];
  result = await finalize(null, root, ['A', 'B', 'C', 'D', 'E', 'G'], {
    moveProjectAfterImport: true,
    workProjectNames: ['A', 'B', 'C', 'D', 'G'],
  });
  assert.strictEqual(statuses.get('a'), '后期中', 'successful work import must move a pending-shoot project');
  assert.strictEqual(statuses.get('b'), '策划中');
  assert.strictEqual(statuses.get('c'), '自定义分类');
  assert.strictEqual(statuses.get('d'), '已归档');
  assert.strictEqual(statuses.get('e'), '待拍摄', 'b-roll-only project must not move');
  assert.strictEqual(statuses.get('g'), '未分类');
  assert.deepStrictEqual(result.movedProjects.map(project => project.name), ['A']);
  assert.deepStrictEqual(new Set(scans.map(scan => scan.name)), new Set(['A', 'B', 'C', 'D', 'E', 'G']));
  assert(scans.every(scan => scan.changes.length === 0 && scan.fullScan === true), 'missing precise import paths must explicitly request a full scan');

  const updatesBeforeRepeat = statusUpdates.length;
  result = await finalize(null, root, ['A', 'A'], { moveProjectAfterImport: true, workProjectNames: ['A', 'A'] });
  assert.strictEqual(result.success, true);
  assert.strictEqual(statusUpdates.length, updatesBeforeRepeat, 'repeated completion must be idempotent');

  result = await finalize(null, root, ['H', 'F', 'H'], { moveProjectAfterImport: true, workProjectNames: ['H', 'F', 'H'] });
  assert.strictEqual(statuses.get('h'), '后期中', 'one project failure must not block other projects');
  assert.strictEqual(statuses.get('f'), '待拍摄');
  assert.deepStrictEqual(result.movedProjects.map(project => project.name), ['H']);
  assert.deepStrictEqual(result.failures.map(failure => failure.projectName), ['F']);
  assert.strictEqual(result.projects.filter(project => project.name === 'H').length, 1, 'batch project names must be deduplicated');

  const updatesBeforeEmpty = statusUpdates.length;
  result = await finalize(null, root, [], { moveProjectAfterImport: true, workProjectNames: [] });
  assert.strictEqual(result.success, true);
  assert.strictEqual(statusUpdates.length, updatesBeforeEmpty, 'skipped, cancelled, failed, or zero-count completions must submit no work projects and move nothing');

  const malicious = await finalize(null, root, ['C:\\outside', '../A'], { moveProjectAfterImport: true, workProjectNames: ['C:\\outside', '../A'] });
  assert.strictEqual(malicious.success, true);
  assert.deepStrictEqual(malicious.projects, [], 'renderer must not finalize arbitrary absolute or traversal paths');

  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-sd-finalize-index-'));
  try {
    const realProject = path.join(realRoot, 'Imported');
    const importedFiles = Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, index) => path.join(realProject, `from-sd-${index}.jpg`));
    const database = path.join(realRoot, 'workspace.sqlite3');
    fs.mkdirSync(realProject);
    for (const importedFile of importedFiles) fs.writeFileSync(importedFile, 'real imported media');
    const python = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
    const pythonModules = path.join(__dirname, '..', 'python');
    const invokeCode = 'import json,sys;sys.path.insert(0,sys.argv[1]);import workspace_db;a,r,d=sys.argv[2:];p=json.load(sys.stdin);v=workspace_db.load(r,d) if a=="init" else workspace_db.mutate(r,d,a,p);print(json.dumps(v,ensure_ascii=False))';
    const invoke = (action, payload = {}) => {
      const child = spawnSync(python, ['-c', invokeCode, pythonModules, action, realRoot, database], { encoding: 'utf8', input: JSON.stringify(payload) });
      if (child.status !== 0) throw new Error(child.stderr || child.stdout);
      return JSON.parse(child.stdout);
    };
    invoke('init');
    const initialized = invoke('catalog_sync');
    const realCatalog = { projects: initialized.projects };
    const realHandlers = new Map();
    const capturedScans = [];
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String,
      HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(['.jpg']), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(), WORKSPACE_STATUSES: ['未分类', '策划中', '待拍摄', '后期中', '已归档'],
      ipcMain: { handle: (channel, handler) => realHandlers.set(channel, handler) },
      ensureWorkspace: value => { assert.strictEqual(value, realRoot); return realRoot; },
      cleanProjectName,
      reconcileWorkspaceCatalog: async () => realCatalog,
      refreshWorkspaceCatalog: async () => realCatalog,
      workspaceRepository: { setProjectStatus: async () => undefined },
      scheduleMediaTrackingScan: (_root, name, changes, fullScan) => {
        capturedScans.push([_root, name, changes, fullScan]);
        assert.strictEqual(fullScan, true);
        assert.deepStrictEqual(changes, []);
        const prepared = invoke('media_sync_prepare', { projectName: name, externalRoots: [] });
        for (let offset = 0; offset < prepared.files.length; offset += 64) invoke('media_sync_apply_batch', {
          projectName: name, snapshotId: prepared.snapshotId, batchIndex: offset / 64,
          authorizedRoots: prepared.authorizedRoots, files: prepared.files.slice(offset, offset + 64),
        });
        invoke('media_sync_finalize', {
          projectName: name, snapshotId: prepared.snapshotId, authorizedRoots: prepared.authorizedRoots,
          files: prepared.files, baselineVersions: prepared.baselineVersions,
        });
      },
      mainWindow: { webContents: { send: () => undefined } },
      fs, path, crypto, getWorkspaceDataRoot: () => path.join(realRoot, '.data'), writeLog: () => undefined,
    });
    const realFinalize = realHandlers.get('workspace-finalize-sd-imports');
    const realResult = await realFinalize(null, realRoot, ['Imported'], {
      moveProjectAfterImport: false, workProjectNames: ['Imported'], importedPathsByProject: { Imported: importedFiles },
    });
    assert.strictEqual(realResult.success, true, realResult.error);
    assert.deepStrictEqual(capturedScans, [[realRoot, 'Imported', [], true]]);
    const probeCode = 'import sys;sys.path.insert(0,sys.argv[1]);import workspace_db;db=workspace_db.connect(sys.argv[2],sys.argv[3],include_domains=True);print(db.execute("SELECT COUNT(*) FROM versions WHERE file_missing=0").fetchone()[0]);print(",".join(db.execute(f"PRAGMA {row[1]}.quick_check").fetchone()[0] for row in db.execute("PRAGMA database_list").fetchall()));db.close()';
    const probe = spawnSync(python, ['-c', probeCode, pythonModules, realRoot, database], { encoding: 'utf8' });
    assert.strictEqual(probe.status, 0, probe.stderr);
    assert.deepStrictEqual(probe.stdout.trim().split(/\r?\n/), [String(importedFiles.length), 'ok,ok,ok'], 'all over-limit TEMP imports must be indexed and every database quick_check must be ok');
  } finally {
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
  console.log('SD import post-action behavior tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
