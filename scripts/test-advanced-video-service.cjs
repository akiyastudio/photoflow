const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');
const { createAdvancedVideoService, nativeWindowHandleValue } = require('../electron/services/advanced-video-service.cjs');

const makeChild = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
};

const run = async () => {
  const nativeHandle = Buffer.alloc(8);
  nativeHandle.writeBigUInt64LE(123456n);
  assert.strictEqual(nativeWindowHandleValue({ getNativeWindowHandle: () => nativeHandle }), '123456');

  const child = makeChild();
  const stdinLines = [];
  child.stdin.on('data', chunk => stdinLines.push(...chunk.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)));
  const sender = new EventEmitter();
  sender.id = 7;
  sender.isDestroyed = () => false;
  sender.sent = [];
  sender.send = (channel, value) => sender.sent.push({ channel, value });
  let spawned;
  const service = createAdvancedVideoService({
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => 'session-1' },
    mediaService: { authorizeInput: async value => path.resolve(value) },
    path,
    pluginService: {
      resolveRunConfig: (_id, args) => ({ command: 'C:\\component\\advanced-video-decoder.exe', args }),
    },
    spawn: (command, args, options) => {
      spawned = { command, args, options };
      process.nextTick(() => child.stdout.write('{"type":"ready"}\n'));
      return child;
    },
    writeLog: () => undefined,
  });

  const result = await service.start({ sender }, 'C:\\workspace\\camera.mov');
  assert.strictEqual(result.sessionId, 'session-1');
  assert.strictEqual(spawned.options.windowsHide, true);
  assert.deepStrictEqual(spawned.args, ['--parent-hwnd', '123456']);
  assert.deepStrictEqual(stdinLines[0], { command: 'open', path: path.resolve('C:\\workspace\\camera.mov') });

  service.setBounds({ sender }, result.sessionId, { x: 10.4, y: 20.6, width: 300.2, height: 200.8, visible: true });
  service.control({ sender }, result.sessionId, { action: 'play' });
  service.control({ sender }, result.sessionId, { action: 'arbitrary-command' });
  assert.deepStrictEqual(stdinLines[1], { command: 'set-bounds', x: 10, y: 21, width: 300, height: 201, visible: true });
  assert.deepStrictEqual(stdinLines[2], { command: 'play' });
  assert.strictEqual(stdinLines.length, 3);

  child.stdout.write('{"type":"state","time":2,"duration":10,"paused":false}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert(sender.sent.some(item => item.channel === 'advanced-video-state' && item.value.sessionId === 'session-1' && item.value.time === 2));

  const screenshotPromise = service.screenshot({ sender }, result.sessionId);
  const screenshotCommand = stdinLines.at(-1);
  assert.strictEqual(screenshotCommand.command, 'screenshot');
  assert.strictEqual(screenshotCommand.requestId, 'session-1');
  assert.strictEqual(path.dirname(screenshotCommand.path), path.dirname(path.resolve('C:\\workspace\\camera.mov')));
  assert.match(path.basename(screenshotCommand.path), /^camera_截图_\d{8}-\d{6}-\d{3}_session-\.png$/);
  child.stdout.write(`${JSON.stringify({ type: 'screenshot-result', requestId: screenshotCommand.requestId, success: true, path: screenshotCommand.path })}\n`);
  assert.deepStrictEqual(await screenshotPromise, { path: screenshotCommand.path });

  const playerSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'components', 'AdvancedVideoPlayer.tsx'), 'utf8');
  const workspaceSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const decoderSource = require('fs').readFileSync(path.join(__dirname, '..', 'components', 'video-playback-mpv', 'AdvancedVideoDecoder.cs'), 'utf8');
  assert(playerSource.includes('onClick={togglePlayback}') && decoderSource.includes('OnMouseClick'), 'clicking the video surface must toggle playback in both renderer and native surfaces');
  assert(playerSource.includes("event.key === 'ArrowRight' ? SKIP_SECONDS : -SKIP_SECONDS") && decoderSource.includes('player.SeekRelative(key == Keys.Right ? 5 : -5)'), 'left and right arrow keys must seek backward and forward by five seconds');
  assert(playerSource.includes('title="上一个视频"') && playerSource.includes('title="下一个视频"'), 'video controls must expose previous-video and next-video buttons');
  assert(playerSource.includes('cycleSpeed') && playerSource.includes('captureAdvancedVideoFrame'), 'video controls must expose playback speed and current-frame capture');
  assert(!playerSource.includes('高级解码</span>'), 'the advanced-decoder label must not remain in the control bar');
  assert(workspaceSource.includes("previewMediaEntries.filter(entry => entry.kind === 'video')"), 'previous and next controls must navigate between videos only');
  assert(workspaceSource.includes("!['image', 'raw'].includes(previewEntry.kind)"), 'image and raw previews must retain left and right navigation');

  assert.strictEqual(service.stop(result.sessionId, sender.id), true);
  assert.strictEqual(service.sessions.size, 0);
  assert.strictEqual(stdinLines.at(-1).command, 'close');
  console.log('Advanced video service tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
