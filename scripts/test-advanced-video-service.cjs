const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const path = require('path');
const { createAdvancedVideoService, nativeWindowHandleValue } = require('../electron/services/advanced-video-service.cjs');
const { normalizeDotnetAssembly } = require('./deterministic-dotnet-assembly.cjs');
const { readPeDependencies } = require('./media-runtime/pe-dependency-closure.cjs');

const makeChild = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinLines = [];
  child.stdin.on('data', chunk => child.stdinLines.push(...chunk.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)));
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
};

const testDeterministicDecoderBuild = () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const frameworkRoot = ['Framework64', 'Framework']
    .map(name => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', name, 'v4.0.30319'))
    .find(candidate => fs.existsSync(path.join(candidate, 'csc.exe')));
  assert(frameworkRoot, 'Windows .NET compiler must be available for the advanced-video build');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-video-deterministic-'));
  try {
    const executable = path.join(sandbox, 'advanced-video-decoder.exe');
    const compile = () => spawnSync(path.join(frameworkRoot, 'csc.exe'), [
      '/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${executable}`,
      `/reference:${path.join(frameworkRoot, 'System.Windows.Forms.dll')}`,
      `/reference:${path.join(frameworkRoot, 'System.Drawing.dll')}`,
      `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
      path.join(__dirname, '..', 'extensions', 'video-playback-mpv', 'AdvancedVideoDecoder.cs'),
    ], { encoding: 'utf8', windowsHide: true });
    const firstCompile = compile();
    assert.strictEqual(firstCompile.status, 0, firstCompile.stderr || firstCompile.stdout);
    const firstHash = normalizeDotnetAssembly(executable);
    const secondCompile = compile();
    assert.strictEqual(secondCompile.status, 0, secondCompile.stderr || secondCompile.stdout);
    const secondHash = normalizeDotnetAssembly(executable);
    assert.strictEqual(secondHash, firstHash, 'normalized decoder builds from identical source must be byte-for-byte reproducible');
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(sandbox));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(sandbox, { recursive: true, force: true });
  }
};

const run = async () => {
  if (process.platform === 'win32') {
    const systemImports = readPeDependencies(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'where.exe'));
    assert(systemImports.includes('kernel32.dll'), 'PE dependency parser must read native Windows import tables');
  }
  const nativeHandle = Buffer.alloc(8);
  nativeHandle.writeBigUInt64LE(123456n);
  assert.strictEqual(nativeWindowHandleValue({ getNativeWindowHandle: () => nativeHandle }), '123456');

  const sender = new EventEmitter();
  sender.id = 7;
  sender.isDestroyed = () => false;
  sender.sent = [];
  sender.send = (channel, value) => sender.sent.push({ channel, value });
  const children = [];
  const spawned = [];
  let uuidIndex = 0;
  const service = createAdvancedVideoService({
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => `session-${++uuidIndex}` },
    mediaService: { authorizeInput: async value => path.resolve(value) },
    path,
    pluginService: {
      resolveRunConfigAsync: async (_id, args) => ({ command: 'C:\\component\\advanced-video-decoder.exe', args }),
    },
    spawn: (command, args, options) => {
      const child = makeChild();
      children.push(child);
      spawned.push({ command, args, options });
      process.nextTick(() => child.stdout.write('{"type":"ready"}\n{"type":"state","time":2,"duration":10,"paused":false,"buffering":false}\n'));
      return child;
    },
    writeLog: () => undefined,
  });

  const result = await service.start({ sender }, 'C:\\workspace\\camera.mov', 'navigate', 'player-one', 'request-one');
  const child = children[0];
  const stdinLines = child.stdinLines;
  assert.strictEqual(result.sessionId, 'session-1');
  assert.strictEqual(spawned[0].options.windowsHide, true);
  assert.deepStrictEqual(spawned[0].args, ['--parent-hwnd', '123456']);
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

  assert(sender.sent.some(item => item.channel === 'advanced-video-state'
    && item.value.sessionId === 'session-1'
    && item.value.playerId === 'player-one'
    && item.value.requestId === 'request-one'
    && item.value.time === 2), 'state emitted before start resolves must retain the renderer-known request identity');

  const screenshotPromise = service.screenshot({ sender }, result.sessionId);
  const screenshotCommand = stdinLines.at(-1);
  assert.strictEqual(screenshotCommand.command, 'screenshot');
  assert.strictEqual(screenshotCommand.requestId, 'session-2');
  assert.strictEqual(path.dirname(screenshotCommand.path), path.dirname(path.resolve('C:\\workspace\\camera.mov')));
  assert.match(path.basename(screenshotCommand.path), /^camera_截图_\d{8}-\d{6}-\d{3}_session-\.png$/);
  child.stdout.write(`${JSON.stringify({ type: 'screenshot-result', requestId: screenshotCommand.requestId, success: true, path: screenshotCommand.path })}\n`);
  assert.deepStrictEqual(await screenshotPromise, { path: screenshotCommand.path });

  const playerSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'components', 'AdvancedVideoPlayer.tsx'), 'utf8');
  const workspaceSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const decoderSource = require('fs').readFileSync(path.join(__dirname, '..', 'extensions', 'video-playback-mpv', 'AdvancedVideoDecoder.cs'), 'utf8');
  const decoderBuildSource = require('fs').readFileSync(path.join(__dirname, 'build-advanced-video-decoder.cjs'), 'utf8');
  const runtimeBuildSource = require('fs').readFileSync(path.join(__dirname, 'media-runtime', 'build-libmpv-dependencies-windows.sh'), 'utf8');
  const libmpvBuildSource = require('fs').readFileSync(path.join(__dirname, 'media-runtime', 'build-libmpv-lgpl-windows.sh'), 'utf8');
  assert(decoderBuildSource.includes("verifyPeDependencyClosure(target, ['libmpv-2.dll'])")
    && runtimeBuildSource.includes('libass-disable-iconv.patch')
    && runtimeBuildSource.includes('freetype-disable-bzip2.patch')
    && runtimeBuildSource.includes('libplacebo-static-winpthread.patch')
    && runtimeBuildSource.includes('CMAKE_CXX_STANDARD_LIBRARIES')
    && libmpvBuildSource.includes('verify-bootstrap-archives.cjs')
    && libmpvBuildSource.includes('build-materials/patches'),
  'advanced video release builds must reject incomplete dependency graphs and preserve their trusted source patches');
  assert(decoderBuildSource.includes('SOURCE_DATE_EPOCH')
    && decoderBuildSource.includes('fs.utimesSync')
    && decoderBuildSource.includes('archiveEntries.map')
    && decoderBuildSource.includes('normalizeZipTimestamps'),
  'advanced video packaging must use deterministic metadata, timestamps, and entry ordering');
  assert(decoderSource.includes('SetOption("gpu-api", "d3d11")') && decoderSource.includes('SetOption("hwdec", "auto-safe")'), 'advanced video playback must prefer safe D3D11 hardware decoding with automatic CPU fallback');
  assert(decoderSource.includes('SetOptionalOption("osc", "no")')
    && decoderSource.includes('result != MpvErrorOptionNotFound'),
  'advanced video playback must tolerate LGPL builds without the optional OSC script option');
  assert(playerSource.includes('onClick={togglePlayback}') && decoderSource.includes('OnMouseClick'), 'clicking the video surface must toggle playback in both renderer and native surfaces');
  assert(!playerSource.includes("key === 'BrowserBack'") && !playerSource.includes("key === 'MediaTrackPrevious'") && !decoderSource.includes('key == Keys.BrowserBack') && !decoderSource.includes('Keys.MediaPreviousTrack'), 'browser and media navigation keys must not be repurposed as player controls');
  assert(playerSource.includes("group === 'arrows'") && playerSource.includes("return arrowKeyAction === 'navigate' ? 'seek' : 'navigate'") && playerSource.includes("videoDirectionalAction(keyboardSettings.arrowKeyAction, 'forward-back')") && decoderSource.includes('if (arrowKeysNavigate)'), 'arrow keys and the controls beside play/pause must always resolve to complementary actions');
  assert(!playerSource.includes('event.button !== 3 && event.button !== 4') && !decoderSource.includes('MouseButtons.XButton1'), 'mouse back and forward buttons must retain their normal application behavior');
  assert(decoderSource.includes('if (IsAtEnd()) Check(Run("seek", "0", "absolute+exact")') && decoderSource.includes('{ "paused", player.IsAtEnd() || IsYes(player.GetProperty("pause")) }'), 'playback controls must recover from EOF and report the ended state as paused');
  assert(decoderSource.includes('if (IsAtEnd())') && decoderSource.includes('SeekAbsolute(duration + seconds)'), 'relative seeking must remain available after playback reaches EOF');
  assert(playerSource.includes('backwardControlLabel') && playerSource.includes('forwardControlLabel') && playerSource.includes('runForwardBackControl(-1)') && playerSource.includes('runForwardBackControl(1)'), 'the controls beside play/pause must expose their active seek or navigation behavior');
  assert(playerSource.includes('cyclePlaybackSpeed') && playerSource.includes("controlPanel === 'speed'") && playerSource.includes('absolute bottom-full') && playerSource.includes('PLAYBACK_SPEEDS.map') && playerSource.includes('captureAdvancedVideoFrame'), 'video controls must expose a compact floating playback-speed panel, click-to-cycle speed, and current-frame capture');
  assert(playerSource.includes("controlPanel === 'volume'") && playerSource.includes('aria-label="调整音量"') && playerSource.includes("control('mute', !muted)"), 'volume must use a floating panel above its icon while icon clicks toggle mute');
  assert(playerSource.includes('overlayHole') && playerSource.includes('cornerOverlayHole') && decoderSource.includes('ApplyOverlayHoles'), 'the native video surface must expose only the floating controls and full-screen close-button areas');
  assert(playerSource.includes('hasVisibleExternalModal') && playerSource.includes("'[role=\"dialog\"][aria-modal=\"true\"]'") && playerSource.includes('!coveredByModal'), 'native video surfaces must hide while an external modal dialog covers the workspace');
  assert(playerSource.includes('topRightOverlayHole') && !playerSource.includes('marginTop: Math.max(0, topOverlayInset)') && workspaceSource.includes('topRightOverlayHole={fullscreen && fullscreenControlsVisible ? 72 : 0}'), 'full-screen video must reach the top edge while keeping the close button interactive');
  assert(workspaceSource.includes('autoPlay controls') && workspaceSource.includes('event.currentTarget.play().catch'), 'Chromium fallback video previews must autoplay');
  assert(!playerSource.includes('高级解码</span>'), 'the advanced-decoder label must not remain in the control bar');
  assert(workspaceSource.includes("previewMediaEntries.filter(entry => entry.kind === 'video')"), 'previous and next controls must navigate between videos only');
  assert(workspaceSource.includes("!['image', 'raw'].includes(previewEntry.kind)"), 'image and raw previews must retain left and right navigation');

  const second = await service.start({ sender }, 'C:\\workspace\\second.mov', 'seek', 'player-two', 'request-two');
  assert.strictEqual(second.sessionId, 'session-3');
  assert.strictEqual(service.sessions.size, 2, 'different player instances must coexist in one renderer');
  assert.strictEqual(children[0].stdin.writableEnded, false, 'starting a second player must not stop the first player');

  const restarted = await service.start({ sender }, 'C:\\workspace\\replacement.mov', 'seek', 'player-one', 'request-three');
  assert.strictEqual(restarted.sessionId, 'session-4');
  assert.strictEqual(service.sessions.size, 2, 'restarting one player must replace only that player session');
  assert.strictEqual(children[0].stdin.writableEnded, true);
  assert.strictEqual(children[1].stdin.writableEnded, false);
  assert(sender.sent.some(item => item.value.type === 'stopped' && item.value.requestId === 'request-one'));

  assert.strictEqual(service.stop(restarted.sessionId, sender.id), true);
  assert.strictEqual(service.stop(second.sessionId, sender.id), true);
  assert.strictEqual(service.sessions.size, 0);
  assert.strictEqual(sender.listenerCount('destroyed'), 0, 'stopped sessions must remove their WebContents destroyed listener');
  assert.strictEqual(children[2].stdinLines.at(-1).command, 'close');

  const pendingAuthorization = new Map();
  const raceChildren = [];
  const raceService = createAdvancedVideoService({
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => 'session-race' },
    mediaService: { authorizeInput: value => new Promise(resolve => pendingAuthorization.set(value, resolve)) },
    path,
    pluginService: { resolveRunConfigAsync: async () => ({ command: 'C:\\component\\advanced-video-decoder.exe', args: [] }) },
    spawn: () => {
      const raceChild = makeChild();
      raceChildren.push(raceChild);
      process.nextTick(() => raceChild.stdout.write('{"type":"ready"}\n'));
      return raceChild;
    },
    writeLog: () => undefined,
  });
  const oldPath = 'C:\\workspace\\slow-old.mov';
  const newPath = 'C:\\workspace\\fast-new.mov';
  const supersededOutcome = raceService.start({ sender }, oldPath, 'seek', 'player-race', 'request-old')
    .then(() => null, error => error);
  const latestStart = raceService.start({ sender }, newPath, 'seek', 'player-race', 'request-new');
  pendingAuthorization.get(oldPath)(path.resolve(oldPath));
  const supersededError = await supersededOutcome;
  assert.match(supersededError?.message || '', /已被替换/);
  assert.strictEqual(raceChildren.length, 0, 'a superseded launch must not spawn a decoder after authorization finishes');
  pendingAuthorization.get(newPath)(path.resolve(newPath));
  const latest = await latestStart;
  assert.strictEqual(latest.requestId, 'request-new');
  assert.strictEqual(raceService.sessions.size, 1, 'only the newest same-player launch may survive');
  raceService.stop(latest.sessionId, sender.id);

  const pendingRunConfigs = [];
  const integrityRaceChildren = [];
  const integrityRaceService = createAdvancedVideoService({
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => 'session-integrity-race' },
    mediaService: { authorizeInput: async value => path.resolve(value) },
    path,
    pluginService: { resolveRunConfigAsync: () => new Promise(resolve => pendingRunConfigs.push(resolve)) },
    spawn: () => {
      const child = makeChild();
      integrityRaceChildren.push(child);
      process.nextTick(() => child.stdout.write('{"type":"ready"}\n'));
      return child;
    },
    writeLog: () => undefined,
  });
  const staleIntegrityStart = integrityRaceService.start({ sender }, oldPath, 'seek', 'player-integrity-race', 'request-integrity-old')
    .then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  const currentIntegrityStart = integrityRaceService.start({ sender }, newPath, 'seek', 'player-integrity-race', 'request-integrity-new');
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(pendingRunConfigs.length, 2);
  pendingRunConfigs[0]({ command: 'C:\\component\\advanced-video-decoder.exe', args: [] });
  const staleIntegrityError = await staleIntegrityStart;
  assert.match(staleIntegrityError?.message || '', /已被替换/);
  assert.strictEqual(integrityRaceChildren.length, 0, 'a superseded launch must not spawn after integrity verification finishes');
  pendingRunConfigs[1]({ command: 'C:\\component\\advanced-video-decoder.exe', args: [] });
  const currentIntegrity = await currentIntegrityStart;
  assert.strictEqual(integrityRaceChildren.length, 1);
  integrityRaceService.stop(currentIntegrity.sessionId, sender.id);
  testDeterministicDecoderBuild();
  console.log('Advanced video service tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
