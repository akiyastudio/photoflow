const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const program = String.raw`
import json, os, sys, tempfile, types
sys.path.insert(0, os.path.join(sys.argv[1], 'python'))
pil = types.ModuleType('PIL')
pil.Image = types.ModuleType('PIL.Image')
pil.ImageOps = types.ModuleType('PIL.ImageOps')
sys.modules['PIL'] = pil
sys.modules['PIL.Image'] = pil.Image
sys.modules['PIL.ImageOps'] = pil.ImageOps
pi_heif = types.ModuleType('pi_heif')
pi_heif.register_heif_opener = lambda **_kwargs: None
sys.modules['pi_heif'] = pi_heif
from classify import build_import_graph_manifest, load_import_graph_receipt, write_import_graph_receipt
root = os.path.join(sys.argv[1], 'fixture-project')
case = sys.argv[2]
imported = []
generated_jpg = []
generated_preview = []
if case in ('camera', 'receipt'): imported = [os.path.join(root, 'slot-a', 'A.CR3'), os.path.join(root, 'slot-b', 'A.JPG')]
if case == 'generated':
    imported = [os.path.join(root, 'slot-a', 'A.CR3')]
    generated_jpg = [os.path.join(root, 'slot-b', 'A.jpg')]
if case == 'jpg-only': imported = [os.path.join(root, 'arbitrary-camera-folder', 'A.JPG')]
if case == 'video':
    imported = [os.path.join(root, 'source-video', 'A.MOV')]
    generated_preview = [os.path.join(root, 'rendered-video', 'A.mp4')]
if case == 'mixed-jpg':
    imported = [os.path.join(root, 'shared-jpg', 'camera.JPG')]
    generated_jpg = [os.path.join(root, 'shared-jpg', 'generated.jpg')]
manifest = build_import_graph_manifest(sys.argv[1], root, 'fixture-project', 'session-1', imported, generated_jpg, generated_preview)
if case == 'receipt':
    with tempfile.TemporaryDirectory() as directory:
        receipt_path = write_import_graph_receipt(directory, 'session-1', [manifest])
        print(json.dumps({'exists': os.path.isfile(receipt_path), 'receipt': load_import_graph_receipt(directory)}, ensure_ascii=False))
else:
    print(json.dumps(manifest, ensure_ascii=False))
`;

const runCase = name => {
  const result = spawnSync(python, ['-c', program, repositoryRoot, name], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
};

const camera = runCase('camera');
assert.equal(camera.schemaVersion, 2);
assert.deepEqual(camera.artifacts.map(item => [item.relativePath, item.importSlot]), [['slot-a', 'raw'], ['slot-b', 'camera_jpg']]);
assert.equal('relations' in camera, false, 'renderer-facing manifest must not carry edgeKind');
assert.equal('nodeRole' in camera.artifacts[0], false, 'renderer-facing manifest must not carry node roles');
assert.equal(runCase('generated').artifacts.find(item => item.relativePath === 'slot-b').importSlot, 'generated_jpg');
assert.equal(runCase('jpg-only').artifacts[0].importSlot, 'camera_jpg');
assert.equal(runCase('video').artifacts.find(item => item.relativePath === 'rendered-video')?.importSlot, 'video_preview');
assert.deepEqual(runCase('mixed-jpg').artifacts.map(item => item.importSlot), ['camera_jpg']);
const receiptFixture = runCase('receipt');
assert.equal(receiptFixture.exists, true, 'receipt must be atomically durable before success is emitted');
assert.equal(receiptFixture.receipt.importSessionId, 'session-1');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-import-recovery-'));
const projectRelativePath = path.join('待拍摄', 'P');
const projectPath = path.join(temporaryRoot, projectRelativePath);
fs.mkdirSync(path.join(projectPath, 'raw'), { recursive: true });
const importedMediaPath = path.join(projectPath, 'raw', 'A.CR3');
fs.writeFileSync(importedMediaPath, 'already-imported-media');
const initialMedia = fs.readFileSync(importedMediaPath, 'utf8');
const handlers = new Map();
let failDatabase = false;
let failAckCleanup = false;
const committedPayloads = [];
const runtimeFs = {
  ...fs,
  promises: {
    ...fs.promises,
    rm: async (...args) => {
      if (failAckCleanup) throw new Error('simulated ACK cleanup crash');
      return fs.promises.rm(...args);
    },
  },
};
const catalog = { projects: [{ id: 'project-1', name: 'P', status: '待拍摄', relative_path: projectRelativePath }] };
registerWorkspaceIpc({
  Array, Boolean, Date, Error, Math, Object, Promise, Set, String,
  HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(), WORKSPACE_STATUSES: [],
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  ensureWorkspace: value => { assert.equal(value, temporaryRoot); return temporaryRoot; },
  reconcileWorkspaceCatalog: async () => catalog,
  refreshWorkspaceCatalog: async () => catalog,
  workspaceCatalogs: new Map(),
  versionService: { commitImportGraph: async (_root, payload) => { if (failDatabase) throw new Error('simulated database failure'); committedPayloads.push(payload); return { importSessionId: payload.importSessionId, nodes: [], edges: [] }; } },
  fs: runtimeFs,
  path,
  pathExists: async value => fs.existsSync(value),
  crypto,
  getWorkspaceDataRoot: () => path.join(temporaryRoot, '.data'),
  writeLog: () => undefined,
});
const recover = handlers.get('workspace-media-workflow-import-recover');
const commit = handlers.get('workspace-media-workflow-import-commit');
assert.equal(typeof recover, 'function');

const manifest = { schemaVersion: 2, projectName: 'P', importSessionId: 'durable-session', artifacts: [{ relativePath: 'raw', mediaKind: 'image', importSlot: 'raw', displayName: 'RAW' }] };
const createReceipt = () => {
  const sessionDir = path.join(temporaryRoot, '_PhotoFlow_Safety_Temp', manifest.importSessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, '.photoflow-import-graph-receipt.json'), JSON.stringify({ receiptVersion: 1, importSessionId: manifest.importSessionId, manifests: [manifest] }));
  return sessionDir;
};

(async () => {
  let sessionDir = createReceipt();
  failDatabase = true;
  let result = await recover(null, temporaryRoot);
  assert.equal(result.success, false, 'database failure must leave the receipt retryable');
  assert.equal(fs.existsSync(sessionDir), true);
  assert.equal(fs.readFileSync(importedMediaPath, 'utf8'), initialMedia, 'recovery must not copy or overwrite imported media');

  failDatabase = false;
  failAckCleanup = true;
  result = await recover(null, temporaryRoot);
  assert.equal(result.success, false, 'a crash after database commit but before ACK cleanup must preserve recovery state');
  assert.equal(fs.existsSync(sessionDir), true);

  failAckCleanup = false;
  result = await recover(null, temporaryRoot);
  assert.equal(result.success, true, 'restart recovery must replay an unacknowledged receipt without renderer storage');
  assert.equal(fs.existsSync(sessionDir), false, 'successful ACK must remove the exact session staging directory');
  assert.equal(fs.readFileSync(importedMediaPath, 'utf8'), initialMedia);

  const rendererPayload = { ...manifest, importSessionId: 'renderer-contract', artifacts: [{ ...manifest.artifacts[0], nodeRole: 'selection', edgeKind: 'workflow_input' }], relations: [{ edgeKind: 'workflow_input' }] };
  result = await commit(null, temporaryRoot, rendererPayload);
  assert.equal(result.success, true);
  const trustedPayload = committedPayloads.at(-1);
  assert.equal('nodeRole' in trustedPayload.artifacts[0], false);
  assert.equal('edgeKind' in trustedPayload.artifacts[0], false);
  assert.equal('relations' in trustedPayload, false, 'renderer cannot submit graph semantics');

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.log('media workflow import manifest and durable receipt tests passed');
})().catch(error => { fs.rmSync(temporaryRoot, { recursive: true, force: true }); console.error(error); process.exitCode = 1; });
