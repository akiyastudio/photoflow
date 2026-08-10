const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { normalizeSdImportAutoMove } = require('../electron/modules/system-ipc.cjs');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');

const handlers = new Map();
const root = 'trusted-workspace';
const statuses = new Map([
  ['a', '待拍摄'], ['b', '策划中'], ['c', '自定义分类'], ['d', '已归档'],
  ['e', '待拍摄'], ['f', '待拍摄'], ['g', '未分类'], ['h', '待拍摄'],
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
  statSync: () => ({ mtimeMs: 123 }),
  promises: {},
};

registerWorkspaceIpc({
  Array, Boolean, Date, Error, Math, Object, Promise, Set, String,
  HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(), WORKSPACE_STATUSES: ['未分类', '策划中', '待拍摄', '后期中', '已归档'],
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
  scheduleMediaTrackingScan: (_root, name) => { assert.strictEqual(_root, root); scans.push(name); },
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
  completion = completionModel.appendImportSuccess(completion, { sourceType: 'work', projectNames: ['A', 'A'], importedCount: 3 });
  completion = completionModel.appendImportSuccess(completion, { sourceType: 'broll', projectNames: ['A', 'B'], importedCount: 2 });
  completion = completionModel.appendImportSuccess(completion, { sourceType: 'work', projectNames: ['C'], importedCount: 0 });
  completion = completionModel.appendImportSuccess(completion, { sourceType: 'work', projectNames: ['D'], importedCount: 9, skipped: true });
  assert.deepStrictEqual(completion.projectNames, ['A', 'B'], 'batch completion project names must be deduplicated from successful events');
  assert.deepStrictEqual(completion.workProjectNames, ['A'], 'only successful work events may identify movable projects');
  assert.deepStrictEqual(completion.brollProjectNames, ['A', 'B'], 'broll projects must remain separately identified');
  assert.strictEqual(completion.importedCount, 5, 'zero and skipped events must not increase imported count');

  const skippedCompletion = completionModel.appendImportSuccess(completionModel.createImportCompletion(), { sourceType: 'work', projectNames: ['A'], importedCount: 0, skipped: true });
  assert.strictEqual(skippedCompletion.skipped, true);
  assert.deepStrictEqual(skippedCompletion.workProjectNames, []);
  const finalize = handlers.get('workspace-finalize-sd-imports');
  assert(finalize, 'finalize SD imports IPC must be registered');

  let result = await finalize(null, root, ['A'], { moveProjectAfterImport: false, workProjectNames: ['A'] });
  assert.strictEqual(result.success, true);
  assert.strictEqual(statuses.get('a'), '待拍摄', 'disabled setting must keep the project category');
  assert.deepStrictEqual(result.movedProjects, []);
  assert.strictEqual(result.unchangedProjects[0].status, '待拍摄');
  assert(scans.includes('A') && refreshCount > 0 && reconcileCount > 0 && projectEvents > 0, 'disabled setting must still reconcile, refresh, scan, and notify');

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
  assert.deepStrictEqual(new Set(scans), new Set(['A', 'B', 'C', 'D', 'E', 'G']));

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
  console.log('SD import post-action behavior tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
