const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { registerFileOperationsIpc } = require('../electron/modules/files-ipc.cjs');
const {
  CANCELLED_CODE,
  assertDiskSpace,
  collectCopyPlan,
  copyPlannedFiles,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
} = require('../electron/services/file-transfer-service.cjs');
const {
  MAX_REMOTE_IMAGE_BYTES,
  assertPublicRemoteHost,
  downloadRemoteImages,
  fetchRemoteImage,
  safeRemoteImageName,
  stageDroppedImageFiles,
} = require('../electron/services/remote-image-download-service.cjs');

const testBase = process.platform === 'win32' && fs.existsSync('C:\\dev\\app2') ? 'C:\\dev\\app2' : os.tmpdir();
const root = fs.mkdtempSync(path.join(testBase, 'photoflow-web-image-test-'));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture')]);
const publicLookup = async () => [{ address: '203.0.114.10', family: 4 }];

const run = async () => {
  try {
    const requests = [];
    const downloaded = await downloadRemoteImages(
      ['https://images.example.test/folder/My%20Photo?size=large'],
      path.join(root, 'downloads'),
      {
        fs, path, net, lookup: publicLookup,
        fetch: async url => { requests.push(url); return new Response(png, { headers: { 'content-type': 'image/png' } }); },
      },
    );
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(path.basename(downloaded[0]), 'My Photo.png');
    assert.deepStrictEqual(fs.readFileSync(downloaded[0]), png);
    assert.strictEqual(safeRemoteImageName(new URL('https://example.test/CON.jpg'), '.jpg', 0), '网页图片1.jpg');

    const stagedProvided = await stageDroppedImageFiles(
      [{ name: 'browser-provided.jpeg', type: 'image/jpeg', bytes: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }],
      path.join(root, 'provided'),
      { fs, path },
    );
    assert.strictEqual(path.basename(stagedProvided[0]), 'browser-provided.png', 'the verified file signature must determine the saved extension');
    await assert.rejects(
      () => stageDroppedImageFiles([{ name: 'fake.png', type: 'image/png', bytes: Buffer.from('<html>no</html>') }], path.join(root, 'fake-provided'), { fs, path }),
      /不是受支持图片/,
    );

    await assert.rejects(
      () => fetchRemoteImage('https://example.test/not-image', { net, lookup: publicLookup, fetch: async () => new Response('<html>no</html>', { headers: { 'content-type': 'text/html' } }) }),
      /不是受支持图片/,
    );
    await assert.rejects(
      () => fetchRemoteImage('https://example.test/too-large', { net, lookup: publicLookup, fetch: async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_REMOTE_IMAGE_BYTES + 1) } }) }),
      /超过 25 MB/,
    );

    let privateFetchCalled = false;
    await assert.rejects(
      () => fetchRemoteImage('http://localhost/image.png', { net, lookup: publicLookup, fetch: async () => { privateFetchCalled = true; return new Response(png); } }),
      /本机或局域网/,
    );
    assert.strictEqual(privateFetchCalled, false);
    await assert.rejects(
      () => assertPublicRemoteHost(new URL('https://internal.example.test/image.png'), { net, lookup: async () => [{ address: '192.168.1.20', family: 4 }] }),
      /本机或局域网/,
    );

    let redirectRequests = 0;
    await assert.rejects(
      () => fetchRemoteImage('https://public.example.test/image', {
        net,
        lookup: async hostname => hostname === 'public.example.test' ? [{ address: '203.0.114.11', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
        fetch: async () => { redirectRequests += 1; return new Response(null, { status: 302, headers: { location: 'http://private.example.test/image.png' } }); },
      }),
      /本机或局域网/,
    );
    assert.strictEqual(redirectRequests, 1, 'redirect targets must be checked before the next request');

    const projectRoot = path.join(root, 'ipc-project');
    const stagingRoot = path.join(root, 'ipc-staging');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(stagingRoot);
    const handlers = new Map();
    let undoOperation = null;
    let ipcFetchCalls = 0;
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} },
      fs, path, net, dns: { promises: { lookup: publicLookup } }, remoteImageTemporaryRoot: stagingRoot,
      fetch: async () => { ipcFetchCalls += 1; return new Response(png, { headers: { 'content-type': 'image/png' } }); },
      getProjectPath: () => projectRoot, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, writeLog: () => {}, ensureWorkspace: value => value,
      cancelMediaTrackingScan: () => {}, suppressWorkspaceWatchPath: () => {}, releaseWorkspaceWatchPath: () => {},
      assertDiskSpace, collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      backgroundTasks: {
        create: () => ({
          deduplicated: false,
          context: { signal: new AbortController().signal, report: () => {}, acquireResourceLease: async () => ({ release: () => true }) },
          waitForStart: async () => {}, complete: () => {}, fail: () => {}, cancelled: () => {}, isFinished: () => false,
        }),
        cancel: () => false,
      },
      pushUndoOperation: async operation => { undoOperation = operation; },
    });
    const providedArrayBuffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    const dataIpcResult = await handlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'import-data', [], '', '',
      { droppedImageFiles: [{ name: 'from-browser-memory.jpg', type: 'image/jpeg', bytes: providedArrayBuffer }] },
    );
    assert.strictEqual(dataIpcResult.success, true);
    assert.deepStrictEqual(fs.readFileSync(path.join(projectRoot, 'from-browser-memory.png')), png);
    assert.strictEqual(ipcFetchCalls, 0, 'browser-provided file bytes must not be downloaded again');
    assert.deepStrictEqual(fs.readdirSync(stagingRoot), [], 'browser-provided file staging must be cleaned after import');

    const ipcResult = await handlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'import-url', ['https://images.example.test/from-browser'], '',
    );
    assert.strictEqual(ipcResult.success, true);
    assert.strictEqual(ipcResult.count, 1);
    assert.strictEqual(ipcFetchCalls, 1);
    assert.deepStrictEqual(fs.readFileSync(path.join(projectRoot, 'from-browser.png')), png);
    assert.strictEqual(undoOperation.kind, 'remove-created');
    assert.deepStrictEqual(fs.readdirSync(stagingRoot), [], 'remote download staging must be cleaned after the local import finishes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().then(() => console.log('remote image download service tests passed')).catch(error => { console.error(error); process.exitCode = 1; });
