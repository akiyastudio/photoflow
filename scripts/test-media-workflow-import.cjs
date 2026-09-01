const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { createImportReceiptService } = require('../electron/modules/workspace/import-receipt-service.cjs');
const { cleanupImportArtifacts } = require('../electron/modules/workspace/import-recovery.cjs');

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
assert.equal(runCase('video').artifacts.find(item => item.relativePath === 'rendered-video')?.importSlot, 'video_transcode');
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
const conflictSessionManifests = new Map();
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
  versionService: { commitImportGraph: async (_root, payload) => {
    if (failDatabase) throw new Error('simulated database failure');
    if (payload.importSessionId === 'renderer-mismatch') {
      const canonical = JSON.stringify(payload);
      if (conflictSessionManifests.has(payload.importSessionId) && conflictSessionManifests.get(payload.importSessionId) !== canonical) {
        throw new Error('import_graph_session_conflict: the import session has a different manifest');
      }
      conflictSessionManifests.set(payload.importSessionId, canonical);
    }
    committedPayloads.push(payload);
    return { importSessionId: payload.importSessionId, nodes: [], edges: [] };
  } },
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
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-receipt-cas-'));
  try {
    const receiptService = createImportReceiptService({ crypto, fs, path, pathExists: async value => fs.existsSync(value), versionService: { commitImportGraph: async () => ({}) } });
    const location = { sessionDir: path.join(receiptRoot, 'session-cas') };
    location.receiptPath = path.join(location.sessionDir, '.photoflow-import-graph-receipt.json');
    fs.mkdirSync(location.sessionDir);
    const manifests = ['A', 'B'].map((projectName, index) => ({ schemaVersion: 2, projectName, importSessionId: 'session-cas', artifacts: [{ relativePath: `slot-${index}`, mediaKind: 'image', importSlot: 'raw' }] }));
    fs.writeFileSync(location.receiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: 'session-cas', manifests }));
    const loaded = await receiptService.readImportReceipt(location.receiptPath);
    assert.equal(loaded.manifests.every(item => /^m-[a-f0-9]{64}$/.test(item.manifestId)), true, 'legacy manifests receive stable content identities');
    await Promise.all(loaded.manifests.map(async item => {
      await receiptService.commitImportManifest(receiptRoot, item);
      await receiptService.acknowledgeImportReceipt(location, item.manifestId, item);
    }));
    assert.equal(fs.existsSync(location.sessionDir), false, 'serialized ACK merge removes staging only after all manifest IDs are durable');
    assert.equal((await receiptService.inspectImportReceipt(location.receiptPath)).status, 'absent');
    fs.mkdirSync(location.sessionDir);
    fs.writeFileSync(location.receiptPath, '{broken');
    assert.equal((await receiptService.inspectImportReceipt(location.receiptPath)).status, 'corrupt');
    fs.writeFileSync(location.receiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: 'wrong', manifests }));
    assert.equal((await receiptService.inspectImportReceipt(location.receiptPath)).status, 'corrupt', 'receipt and manifest sessions must match');
    const ioFailureService = createImportReceiptService({
      crypto, path, pathExists: async () => true, versionService: { commitImportGraph: async () => ({}) },
      fs: { promises: { readFile: async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); } } },
    });
    const ioFailure = await ioFailureService.inspectImportReceipt(location.receiptPath);
    assert.equal(ioFailure.status, 'io-error');
    assert.equal(ioFailure.error.code, 'EACCES');

    const duplicateLocation = { sessionDir: path.join(receiptRoot, 'session-duplicate') };
    duplicateLocation.receiptPath = path.join(duplicateLocation.sessionDir, '.photoflow-import-graph-receipt.json');
    fs.mkdirSync(duplicateLocation.sessionDir);
    const duplicateManifests = [0, 1].map(index => ({ schemaVersion: 2, projectName: 'SAME', importSessionId: 'session-duplicate', artifacts: [{ relativePath: `slot-${index}`, mediaKind: 'image', importSlot: 'raw' }] }));
    fs.writeFileSync(duplicateLocation.receiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: 'session-duplicate', manifests: duplicateManifests, acknowledgedProjects: ['same'] }));
    let duplicateReceipt = await receiptService.readImportReceipt(duplicateLocation.receiptPath);
    assert.deepEqual(duplicateReceipt.acknowledgedManifestIds, [], 'legacy name ACK must not migrate when names are duplicated');
    await receiptService.commitImportManifest(receiptRoot, duplicateManifests[1]);
    await receiptService.acknowledgeImportReceipt(duplicateLocation, 'SAME', duplicateManifests[1]);
    duplicateReceipt = await receiptService.readImportReceipt(duplicateLocation.receiptPath);
    assert.deepEqual(duplicateReceipt.acknowledgedManifestIds, [duplicateReceipt.manifests[1].manifestId], 'projectName ACK consumes the exact successfully committed manifest ID');
    await receiptService.commitImportManifest(receiptRoot, duplicateManifests[1]);
    await receiptService.acknowledgeImportReceipt(duplicateLocation, 'SAME', duplicateManifests[1]);
    duplicateReceipt = await receiptService.readImportReceipt(duplicateLocation.receiptPath);
    assert.deepEqual(duplicateReceipt.acknowledgedManifestIds, [duplicateReceipt.manifests[1].manifestId], 'retrying an already ACKed same-name commit must be an idempotent no-op');
    assert.equal(fs.existsSync(duplicateLocation.sessionDir), true, 'a retry must not consume another same-name manifest or delete staging');
    await receiptService.commitImportManifest(receiptRoot, duplicateManifests[0]);
    await receiptService.acknowledgeImportReceipt(duplicateLocation, 'SAME', duplicateManifests[0]);
    assert.equal(fs.existsSync(duplicateLocation.sessionDir), false, 'staging is removed only after the remaining exact manifest is committed and ACKed');

    fs.mkdirSync(duplicateLocation.sessionDir);
    fs.writeFileSync(duplicateLocation.receiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: 'session-duplicate', manifests: duplicateManifests }));
    duplicateReceipt = await receiptService.readImportReceipt(duplicateLocation.receiptPath);
    const exactFirst = duplicateReceipt.manifests[0];
    await receiptService.commitImportManifest(receiptRoot, exactFirst);
    await receiptService.commitImportManifest(receiptRoot, exactFirst);
    await receiptService.acknowledgeImportReceipt(duplicateLocation, exactFirst.manifestId, exactFirst);
    await assert.rejects(receiptService.acknowledgeImportReceipt(duplicateLocation, exactFirst.manifestId, exactFirst), error => error?.code === 'IMPORT_RECEIPT_MANIFEST_MISMATCH');
    duplicateReceipt = await receiptService.readImportReceipt(duplicateLocation.receiptPath);
    assert.deepEqual(duplicateReceipt.acknowledgedManifestIds, [duplicateReceipt.manifests[0].manifestId]);
    await assert.rejects(receiptService.acknowledgeImportReceipt(duplicateLocation, 'SAME', duplicateManifests[1]), error => error?.code === 'IMPORT_RECEIPT_MANIFEST_MISMATCH');
    duplicateReceipt = await receiptService.readImportReceipt(duplicateLocation.receiptPath);
    assert.deepEqual(duplicateReceipt.acknowledgedManifestIds, [duplicateReceipt.manifests[0].manifestId], 'repeated exact ACKs must leave no stale queue item that can consume another same-name manifest');

    const retryManifest = { schemaVersion: 2, manifestId: 'retry-manifest', projectName: 'RETRY', importSessionId: 'session-retry', artifacts: [{ relativePath: 'slot', mediaKind: 'image', importSlot: 'raw' }] };
    const retryLocations = ['a', 'b'].map(name => {
      const sessionDir = path.join(receiptRoot, `retry-${name}`, retryManifest.importSessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const receiptPath = path.join(sessionDir, '.photoflow-import-graph-receipt.json');
      fs.writeFileSync(receiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: retryManifest.importSessionId, manifests: [retryManifest] }));
      return { sessionDir, receiptPath };
    });
    let failFirstRetryCleanup = true;
    const retryFs = { ...fs, promises: { ...fs.promises, rm: async (target, options) => {
      if (failFirstRetryCleanup && path.resolve(target) === path.resolve(retryLocations[0].sessionDir) && options?.recursive) {
        failFirstRetryCleanup = false;
        throw new Error('simulated first-location ACK cleanup failure');
      }
      return fs.promises.rm(target, options);
    } } };
    const retryReceiptService = createImportReceiptService({ crypto, fs: retryFs, path, pathExists: async value => fs.existsSync(value), versionService: { commitImportGraph: async () => ({}) } });
    await retryReceiptService.commitImportManifest(receiptRoot, retryManifest, 2);
    await assert.rejects(retryReceiptService.acknowledgeImportReceipt(retryLocations[0], retryManifest.manifestId, retryManifest), /cleanup failure/);
    await retryReceiptService.commitImportManifest(receiptRoot, retryManifest, 2);
    await retryReceiptService.acknowledgeImportReceipt(retryLocations[0], retryManifest.manifestId, retryManifest);
    await retryReceiptService.acknowledgeImportReceipt(retryLocations[1], retryManifest.manifestId, retryManifest);
    fs.mkdirSync(retryLocations[1].sessionDir, { recursive: true });
    fs.writeFileSync(retryLocations[1].receiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: retryManifest.importSessionId, manifests: [retryManifest] }));
    await assert.rejects(
      retryReceiptService.acknowledgeImportReceipt(retryLocations[1], retryManifest.manifestId, retryManifest),
      error => error?.code === 'IMPORT_RECEIPT_MANIFEST_MISMATCH',
      'a completed retry must leave no stale credential that can ACK a rebuilt receipt without a new DB commit',
    );
    assert.equal(fs.existsSync(retryLocations[1].sessionDir), true);

    const allowedRoot = path.join(receiptRoot, 'owned');
    const owned = path.join(allowedRoot, 'child');
    fs.mkdirSync(owned, { recursive: true });
    const unauthorized = await cleanupImportArtifacts({ fs, virtualPaths: { revokeManagedExternalLinkIds: () => undefined }, targets: [owned] });
    assert.equal(unauthorized.leftoverPaths.includes(owned), true);
    assert.match(unauthorized.cleanupErrors[0].error, /缺少 allowedRoots\/ownedTargets/);
    const denied = await cleanupImportArtifacts({ fs, virtualPaths: { revokeManagedExternalLinkIds: () => undefined }, targets: [owned], allowedRoots: [allowedRoot], ownedTargets: [] });
    assert.equal(denied.leftoverPaths.includes(owned), true, 'cleanup must reject a target absent from the explicit ownership set');
    const cleaned = await cleanupImportArtifacts({ fs, virtualPaths: { revokeManagedExternalLinkIds: () => undefined }, targets: [owned], allowedRoots: [allowedRoot], ownedTargets: [owned] });
    assert.deepEqual(cleaned.leftoverPaths, []);
  } finally { fs.rmSync(receiptRoot, { recursive: true, force: true }); }

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
  assert.equal(result.success, true, `restart recovery must replay an unacknowledged receipt without renderer storage: ${JSON.stringify(result)}`);
  assert.equal(fs.existsSync(sessionDir), false, 'successful ACK must remove the exact session staging directory');
  assert.equal(fs.readFileSync(importedMediaPath, 'utf8'), initialMedia);

  const sameSession = 'same-name-ipc';
  const sameSessionDir = path.join(temporaryRoot, '_PhotoFlow_Safety_Temp', sameSession);
  const sameReceiptPath = path.join(sameSessionDir, '.photoflow-import-graph-receipt.json');
  const sameManifests = ['manifest-first', 'manifest-second'].map((manifestId, index) => ({
    schemaVersion: 2, manifestId, projectName: 'P', importSessionId: sameSession,
    artifacts: [{ relativePath: 'raw', mediaKind: 'image', importSlot: 'raw', displayName: 'RAW' }],
  }));
  fs.mkdirSync(sameSessionDir, { recursive: true });
  fs.writeFileSync(sameReceiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: sameSession, manifests: sameManifests }));
  result = await commit(null, temporaryRoot, sameManifests[1]);
  assert.equal(result.success, true);
  let sameReceipt = JSON.parse(fs.readFileSync(sameReceiptPath, 'utf8'));
  assert.deepEqual(sameReceipt.acknowledgedManifestIds, ['manifest-second'], 'commit IPC must ACK the exact same-name manifest ID');
  assert.equal(fs.existsSync(sameSessionDir), true, 'ACKing one same-name manifest must not delete the receipt');
  const committedBeforeSameRecovery = committedPayloads.length;
  result = await recover(null, temporaryRoot);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(committedPayloads.length, committedBeforeSameRecovery + 1, 'recover IPC must replay only the unacknowledged manifest ID');
  assert.equal(committedPayloads.at(-1).manifestId, undefined, 'only trusted manifest content, not renderer identity fields, reaches the database');
  assert.equal(fs.existsSync(sameSessionDir), false, 'receipt may be removed only after both exact manifest IDs are acknowledged');

  const legacyUniqueSession = 'legacy-unique-ipc';
  const legacyUniqueDir = path.join(temporaryRoot, '_PhotoFlow_Safety_Temp', legacyUniqueSession);
  const legacyUniqueManifest = { ...manifest, projectName: 'LEGACY', importSessionId: legacyUniqueSession };
  fs.mkdirSync(legacyUniqueDir, { recursive: true });
  fs.writeFileSync(path.join(legacyUniqueDir, '.photoflow-import-graph-receipt.json'), JSON.stringify({ receiptVersion: 1, importSessionId: legacyUniqueSession, manifests: [legacyUniqueManifest] }));
  result = await commit(null, temporaryRoot, legacyUniqueManifest);
  assert.equal(result.success, true, 'a legacy renderer payload without manifestId remains compatible when the receipt name is unique');
  assert.equal(fs.existsSync(legacyUniqueDir), false);

  fs.mkdirSync(sameSessionDir, { recursive: true });
  fs.writeFileSync(sameReceiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: sameSession, manifests: sameManifests }));
  const committedBeforeLegacyAmbiguity = committedPayloads.length;
  const legacyAmbiguousPayload = { ...sameManifests[0] };
  delete legacyAmbiguousPayload.manifestId;
  result = await commit(null, temporaryRoot, legacyAmbiguousPayload);
  assert.equal(result.success, false, 'a legacy payload without manifestId must fail closed when same-name receipt candidates are ambiguous');
  assert.equal(result.code, 'IMPORT_RECEIPT_MANIFEST_AMBIGUOUS');
  assert.equal(committedPayloads.length, committedBeforeLegacyAmbiguity, 'legacy ambiguity must be rejected before the database call');
  assert.equal(fs.existsSync(sameSessionDir), true, 'ambiguous receipt state must remain available for exact-ID recovery');
  fs.rmSync(sameSessionDir, { recursive: true, force: true });

  const committedBeforeAbsent = committedPayloads.length;
  result = await commit(null, temporaryRoot, { ...manifest, importSessionId: 'missing-receipt' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'IMPORT_RECEIPT_ABSENT');
  assert.equal(committedPayloads.length, committedBeforeAbsent, 'missing receipts must fail before any database call');

  const multiSession = 'multi-location';
  const multiManifest = { ...manifest, manifestId: 'multi-location-manifest', importSessionId: multiSession };
  const multiLocations = [temporaryRoot, projectPath].map(root => path.join(root, '_PhotoFlow_Safety_Temp', multiSession));
  for (const sessionDirectory of multiLocations) {
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionDirectory, '.photoflow-import-graph-receipt.json'), JSON.stringify({ receiptVersion: 1, importSessionId: multiSession, manifests: [multiManifest] }));
  }
  result = await commit(null, temporaryRoot, multiManifest);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(multiLocations.every(sessionDirectory => !fs.existsSync(sessionDirectory)), true, 'all consistent receipt locations must ACK the same canonical manifest');

  const divergentSession = 'multi-location-divergent';
  const divergentManifest = { ...manifest, manifestId: 'multi-divergent-manifest', importSessionId: divergentSession };
  const divergentLocations = [temporaryRoot, projectPath].map(root => path.join(root, '_PhotoFlow_Safety_Temp', divergentSession));
  for (const [index, sessionDirectory] of divergentLocations.entries()) {
    fs.mkdirSync(sessionDirectory, { recursive: true });
    const stored = index === 0 ? divergentManifest : { ...divergentManifest, artifacts: [{ ...divergentManifest.artifacts[0], relativePath: 'different-receipt-content' }] };
    fs.writeFileSync(path.join(sessionDirectory, '.photoflow-import-graph-receipt.json'), JSON.stringify({ receiptVersion: 1, importSessionId: divergentSession, manifests: [stored] }));
  }
  const committedBeforeDivergence = committedPayloads.length;
  result = await commit(null, temporaryRoot, divergentManifest);
  assert.equal(result.success, false);
  assert.equal(result.code, 'IMPORT_RECEIPT_MANIFEST_MISMATCH');
  assert.equal(committedPayloads.length, committedBeforeDivergence, 'divergent receipt locations must fail before any database call');
  assert.equal(divergentLocations.every(sessionDirectory => fs.existsSync(sessionDirectory)), true);
  for (const sessionDirectory of divergentLocations) fs.rmSync(sessionDirectory, { recursive: true, force: true });

  const mismatchSession = 'renderer-mismatch';
  const mismatchSessionDir = path.join(temporaryRoot, '_PhotoFlow_Safety_Temp', mismatchSession);
  const mismatchReceiptPath = path.join(mismatchSessionDir, '.photoflow-import-graph-receipt.json');
  const receiptManifest = {
    schemaVersion: 2, manifestId: 'valid-renderer-id', projectName: 'P', importSessionId: mismatchSession,
    artifacts: [{ relativePath: 'receipt-content', mediaKind: 'image', importSlot: 'raw', displayName: 'Receipt content' }],
  };
  fs.mkdirSync(mismatchSessionDir, { recursive: true });
  fs.writeFileSync(mismatchReceiptPath, JSON.stringify({ receiptVersion: 1, importSessionId: mismatchSession, manifests: [receiptManifest] }));
  const committedBeforeMismatch = committedPayloads.length;
  result = await commit(null, temporaryRoot, {
    ...receiptManifest,
    artifacts: [{ ...receiptManifest.artifacts[0], relativePath: 'renderer-substitution' }],
  });
  assert.equal(result.success, false, 'a syntactically valid renderer manifestId must not ACK different committed content');
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.code, 'IMPORT_RECEIPT_MANIFEST_MISMATCH');
  assert.equal(committedPayloads.length, committedBeforeMismatch, 'receipt mismatch must be rejected before any database call');
  assert.equal(fs.existsSync(mismatchSessionDir), true, 'mismatched receipt files must be preserved');
  let mismatchReceipt = JSON.parse(fs.readFileSync(mismatchReceiptPath, 'utf8'));
  assert.deepEqual(mismatchReceipt.acknowledgedManifestIds || [], []);
  result = await recover(null, temporaryRoot);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(fs.existsSync(mismatchSessionDir), false, 'recovery may ACK the receipt only after committing its exact content');

  const corruptSession = 'corrupt-recovery';
  const corruptSessionDir = path.join(temporaryRoot, '_PhotoFlow_Safety_Temp', corruptSession);
  const corruptReceiptPath = path.join(corruptSessionDir, '.photoflow-import-graph-receipt.json');
  fs.mkdirSync(corruptSessionDir, { recursive: true });
  fs.writeFileSync(corruptReceiptPath, '{broken');
  result = await recover(null, temporaryRoot);
  assert.equal(result.success, false);
  assert.equal(result.failures.some(failure => failure.importSessionId === corruptSession
    && failure.code === 'IMPORT_RECEIPT_CORRUPT' && failure.recoveryRequired === true), true,
  'corrupt receipts must be surfaced as structured, recoverable failures');
  assert.equal(fs.existsSync(corruptReceiptPath), true, 'uncertain recovery files must never be deleted');

  const rendererPayload = { ...manifest, importSessionId: 'renderer-contract', artifacts: [{ ...manifest.artifacts[0], nodeRole: 'selection', edgeKind: 'workflow_input' }], relations: [{ edgeKind: 'workflow_input' }] };
  const rendererSessionDir = path.join(temporaryRoot, '_PhotoFlow_Safety_Temp', rendererPayload.importSessionId);
  fs.mkdirSync(rendererSessionDir, { recursive: true });
  fs.writeFileSync(path.join(rendererSessionDir, '.photoflow-import-graph-receipt.json'), JSON.stringify({
    receiptVersion: 1, importSessionId: rendererPayload.importSessionId, manifests: [rendererPayload],
  }));
  result = await commit(null, temporaryRoot, rendererPayload);
  assert.equal(result.success, true);
  const trustedPayload = committedPayloads.at(-1);
  assert.equal('nodeRole' in trustedPayload.artifacts[0], false);
  assert.equal('edgeKind' in trustedPayload.artifacts[0], false);
  assert.equal('relations' in trustedPayload, false, 'renderer cannot submit graph semantics');

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.log('media workflow import manifest and durable receipt tests passed');
})().catch(error => { fs.rmSync(temporaryRoot, { recursive: true, force: true }); console.error(error); process.exitCode = 1; });
