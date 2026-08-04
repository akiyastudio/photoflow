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

  const result = await service.start({ sender }, 'C:\\workspace\\camera.mov', 'navigate');
  assert.strictEqual(result.sessionId, 'session-1');
  assert.strictEqual(spawned.options.windowsHide, true);
  assert.deepStrictEqual(spawned.args, ['--parent-hwnd', '123456']);
  assert.deepStrictEqual(stdinLines[0], { command: 'set-keyboard-mode', value: 'navigate' });
  assert.deepStrictEqual(stdinLines[1], { command: 'open', path: path.resolve('C:\\workspace\\camera.mov') });
  assert.deepStrictEqual(stdinLines[2], { command: 'play' });

  service.setBounds({ sender }, result.sessionId, {
    x: 10.4, y: 20.6, width: 300.2, height: 200.8, visible: true,
    overlayHole: { x: 210.2, y: 80.4, width: 120.7, height: 150.1 },
    cornerOverlayHole: { x: 240.4, y: 0, width: 80.2, height: 72.1 },
  });
  service.control({ sender }, result.sessionId, { action: 'play' });
  service.control({ sender }, result.sessionId, { action: 'arbitrary-command' });
  assert.deepStrictEqual(stdinLines[3], {
    command: 'set-bounds', x: 10, y: 21, width: 300, height: 201, visible: true,
    holeX: 210, holeY: 80, holeWidth: 90, holeHeight: 121,
    cornerHoleX: 240, cornerHoleY: 0, cornerHoleWidth: 60, cornerHoleHeight: 72,
  });
  assert.deepStrictEqual(stdinLines[4], { command: 'play' });
  assert.strictEqual(stdinLines.length, 5);

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
  assert(decoderSource.includes('SetOption("gpu-api", "d3d11")') && decoderSource.includes('SetOption("hwdec", "auto-safe")'), 'advanced video playback must prefer safe D3D11 hardware decoding with automatic CPU fallback');
  assert(playerSource.includes('onClick={togglePlayback}') && decoderSource.includes('OnMouseClick'), 'clicking the video surface must toggle playback in both renderer and native surfaces');
  assert(playerSource.includes("key === 'BrowserBack'") && playerSource.includes("key === 'MediaTrackPrevious'") && decoderSource.includes('key == Keys.BrowserBack') && decoderSource.includes('Keys.MediaPreviousTrack'), 'browser and media navigation keys must use the forward/back key group');
  assert(playerSource.includes("group === 'arrows'") && playerSource.includes("return arrowKeyAction === 'navigate' ? 'seek' : 'navigate'") && decoderSource.includes('arrowKeys == arrowKeysNavigate'), 'arrow and forward/back key groups must always resolve to complementary actions');
  assert(playerSource.includes('event.button !== 3 && event.button !== 4') && decoderSource.includes('MouseButtons.XButton1'), 'mouse back and forward buttons must follow the browser-key mapping');
  assert(decoderSource.includes('if (IsAtEnd()) Check(Run("seek", "0", "absolute+exact")') && decoderSource.includes('{ "paused", player.IsAtEnd() || IsYes(player.GetProperty("pause")) }'), 'playback controls must recover from EOF and report the ended state as paused');
  assert(decoderSource.includes('if (IsAtEnd())') && decoderSource.includes('SeekAbsolute(duration + seconds)'), 'relative seeking must remain available after playback reaches EOF');
  assert(playerSource.includes('title="上一个视频"') && playerSource.includes('title="下一个视频"'), 'video controls must expose previous-video and next-video buttons');
  assert(playerSource.includes('cyclePlaybackSpeed') && playerSource.includes("controlPanel === 'speed'") && playerSource.includes('absolute bottom-full') && playerSource.includes('PLAYBACK_SPEEDS.map') && playerSource.includes('captureAdvancedVideoFrame'), 'video controls must expose a compact floating playback-speed panel, click-to-cycle speed, and current-frame capture');
  assert(playerSource.includes("controlPanel === 'volume'") && playerSource.includes('aria-label="调整音量"') && playerSource.includes("control('mute', !muted)"), 'volume must use a floating panel above its icon while icon clicks toggle mute');
  assert(playerSource.includes('overlayHole') && playerSource.includes('cornerOverlayHole') && decoderSource.includes('ApplyOverlayHoles'), 'the native video surface must expose only the floating controls and full-screen close-button areas');
  assert(playerSource.includes('topRightOverlayHole') && !playerSource.includes('marginTop: Math.max(0, topOverlayInset)') && workspaceSource.includes('topRightOverlayHole={fullscreen && fullscreenControlsVisible ? 72 : 0}'), 'full-screen video must reach the top edge while keeping the close button interactive');
  assert(workspaceSource.includes('autoPlay controls') && workspaceSource.includes('event.currentTarget.play().catch'), 'Chromium fallback video previews must autoplay');
  assert(!playerSource.includes('高级解码</span>'), 'the advanced-decoder label must not remain in the control bar');
  assert(workspaceSource.includes("previewMediaEntries.filter(entry => entry.kind === 'video')"), 'previous and next controls must navigate between videos only');
  assert(workspaceSource.includes("!['image', 'raw'].includes(previewEntry.kind)"), 'image and raw previews must retain left and right navigation');

  assert.strictEqual(service.stop(result.sessionId, sender.id), true);
  assert.strictEqual(service.sessions.size, 0);
  assert.strictEqual(sender.listenerCount('destroyed'), 0, 'stopped sessions must remove their WebContents destroyed listener');
  assert.strictEqual(stdinLines.at(-1).command, 'close');
  console.log('Advanced video service tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
