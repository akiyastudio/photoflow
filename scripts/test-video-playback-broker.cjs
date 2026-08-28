const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerVideoPlaybackIpc: registerAdvancedVideoIpc } = require('../electron/modules/video-playback-ipc.cjs');
const { createMediaFileResponse } = require('../electron/services/media-response-service.cjs');
const { parseMediaPlaybackBackendContributions } = require('../electron/contracts/media-playback-backend-contract.cjs');

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
      path,
      pluginService: {
        list: () => [{
          id: 'fixture-player', name: 'Fixture Player', installed: true, compatible: true,
          manifest: { runtimeContributions: [{ type: 'media.playbackBackend', protocolVersion: 1, backendId: 'decoder', displayName: 'Fixture decoder', backendVersion: '1.2.3', transport: 'media-playback-backend-v1', priority: 1000, probe: { containers: ['mp4', 'mov'], codecs: { video: ['h264', 'hevc'], audio: ['aac'] }, extensions: ['.mp4', '.mov'] }, features: { transforms: ['source', 'contain', 'cover', 'rotate'], hdr: { modes: ['auto', 'sdr', 'tone-map'], requiresHdrDisplay: false }, statistics: { levels: ['basic', 'detailed'], maxUpdateHz: 10 }, subtitles: { formats: ['vtt', 'srt'], externalFiles: true }, hardwareDecoding: true, capture: { supported: true, appliesTransforms: true } } }] },
        }, { id: 'undeclared-runtime', name: 'Old Runtime', installed: true, compatible: true, manifest: {} }],
        resolveRunConfigAsync: async () => ({ command: 'fixture.exe', args: [] }),
      },
      spawn() {}, writeLog() {},
    });

    const source = await handlers.get('video-playback-source')({}, sourcePath);
    assert.deepEqual(source, { success: true, mediaUrl: 'photoflow-media://file/clip.mp4' });
    const discovered = await handlers.get('video-playback-backends')({}, sourcePath, 'maybe');
    assert.equal(discovered.success, true);
    assert.deepEqual(discovered.backends.map(item => item.backendId), ['core.chromium', 'fixture-player:decoder'], 'ordinary MP4 must prefer core Chromium even when a component declares maximum priority');
    assert.equal(discovered.backends.some(item => item.backendId.includes('undeclared-runtime')), false, 'an undeclared historical runtime must not be promoted into the v1 protocol');
    assert.equal(discovered.backends[1].probe.basis, 'manifest-extension-hint');
    const unknownChromium = await handlers.get('video-playback-backends')({}, sourcePath, 'unknown');
    assert.deepEqual(unknownChromium.backends.map(item => item.backendId), ['fixture-player:decoder', 'core.chromium'], 'an extension-matched component may lead when Chromium has no capability signal');
    assert.throws(() => parseMediaPlaybackBackendContributions({ runtimeContributions: [{ type: 'media.playbackBackend', protocolVersion: 99, backendId: 'bad', displayName: 'Bad', backendVersion: '1.0.0', transport: 'media-playback-backend-v1', priority: 0, probe: { containers: ['mp4'], codecs: { video: [], audio: [] }, extensions: ['.mp4'] }, features: {} }] }), /Unsupported/);

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
