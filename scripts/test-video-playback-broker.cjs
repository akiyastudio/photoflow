const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAdvancedVideoIpc } = require('../electron/modules/advanced-video-ipc.cjs');
const { createMediaFileResponse } = require('../electron/services/media-response-service.cjs');

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-playback-broker-'));
  try {
    const sourcePath = path.join(root, 'clip.mp4');
    fs.writeFileSync(sourcePath, 'video');
    const handlers = new Map();
    let sequence = 0;
    registerAdvancedVideoIpc({
      BrowserWindow: {}, app: { once() {} }, crypto: { randomUUID: () => `broker-${++sequence}` }, dialog: {}, fs,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
      mediaService: { authorizeInput: async value => path.resolve(value), toUrl: value => `photoflow-media://file/${path.basename(value)}` },
      path, pluginService: {}, spawn() {}, writeLog() {},
    });

    const source = await handlers.get('video-playback-source')({}, sourcePath);
    assert.deepEqual(source, { success: true, mediaUrl: 'photoflow-media://file/clip.mp4' });

    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]),
    ]);
    const capture = await handlers.get('video-player-publish-frame')({}, sourcePath, new Uint8Array(png));
    assert.equal(capture.success, true);
    assert.match(path.basename(capture.path), /^clip_截图_\d{8}-\d{6}-\d{3}_broker-1\.png$/);
    assert.deepEqual(fs.readFileSync(capture.path), png);
    assert.equal(fs.readdirSync(root).some(name => name.includes('photoflow-chromium-screenshot')), false, 'published Chromium captures must not leave temporary files');

    const rejected = await handlers.get('video-player-publish-frame')({}, sourcePath, new Uint8Array([1, 2, 3]));
    assert.equal(rejected.success, false);
    assert.match(rejected.error, /截图数据无效/);

    const response = await createMediaFileResponse(sourcePath, new Request('https://media.test/clip.mp4'));
    assert.equal(response.headers.get('access-control-allow-origin'), '*', 'the authorized media response must allow canvas capture from the renderer origin');
    console.log('Video playback broker tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
