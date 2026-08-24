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
  const screenshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-video-screenshot-'));
  const sourceVideo = path.join(screenshotRoot, 'camera.mov');
  fs.writeFileSync(sourceVideo, 'video');

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

  const result = await service.start({ sender }, sourceVideo, 'navigate', 'player-one', 'request-one');
  const child = children[0];
  const stdinLines = child.stdinLines;
  assert.strictEqual(result.sessionId, 'session-1');
  assert.strictEqual(spawned[0].options.windowsHide, true);
  assert.deepStrictEqual(spawned[0].args, ['--parent-hwnd', '123456']);
  assert.deepStrictEqual(stdinLines[0], { command: 'set-keyboard-mode', value: 'navigate' });
  assert.deepStrictEqual(stdinLines[1], { command: 'set-subtitle-defaults', enabled: false, preferredLanguages: [], fontSize: 55, style: 'standard' });
  assert.deepStrictEqual(stdinLines[2], { command: 'open', path: path.resolve(sourceVideo) });
  assert.deepStrictEqual(stdinLines[3], { command: 'play' });

  service.setBounds({ sender }, result.sessionId, {
    x: 10.4, y: 20.6, width: 300.2, height: 200.8, visible: true,
    overlayHole: { x: 210.2, y: 80.4, width: 120.7, height: 150.1 },
    controlsOverlayHole: { x: 0, y: 150.2, width: 300.2, height: 60.1 },
    cornerOverlayHole: { x: 240.4, y: 0, width: 80.2, height: 72.1 },
  });
  service.control({ sender }, result.sessionId, { action: 'play' });
  service.control({ sender }, result.sessionId, { action: 'subtitle-select', value: '3' });
  service.control({ sender }, result.sessionId, { action: 'subtitle-visible', value: false });
  service.control({ sender }, result.sessionId, { action: 'subtitle-delay', value: 1.5 });
  service.control({ sender }, result.sessionId, { action: 'subtitle-style', fontSize: 73, style: 'high-contrast' });
  service.control({ sender }, result.sessionId, { action: 'arbitrary-command' });
  service.control({ sender: { id: 99 } }, result.sessionId, { action: 'pause' });
  assert.deepStrictEqual(stdinLines[4], {
    command: 'set-bounds', x: 10, y: 21, width: 300, height: 201, visible: true,
    holeX: 210, holeY: 80, holeWidth: 90, holeHeight: 121,
    controlsHoleX: 0, controlsHoleY: 150, controlsHoleWidth: 300, controlsHoleHeight: 51,
    cornerHoleX: 240, cornerHoleY: 0, cornerHoleWidth: 60, cornerHoleHeight: 72,
  });
  assert.deepStrictEqual(stdinLines[5], { command: 'play' });
  assert.deepStrictEqual(stdinLines.slice(6), [
    { command: 'subtitle-select', value: '3' },
    { command: 'subtitle-visible', value: false },
    { command: 'subtitle-delay', value: 1.5 },
    { command: 'subtitle-style', fontSize: 73, style: 'high-contrast' },
  ]);
  assert.strictEqual(stdinLines.length, 10, 'only allowlisted commands from the owning renderer may reach the native session');

  assert(sender.sent.some(item => item.channel === 'advanced-video-state'
    && item.value.sessionId === 'session-1'
    && item.value.playerId === 'player-one'
    && item.value.requestId === 'request-one'
    && item.value.time === 2), 'state emitted before start resolves must retain the renderer-known request identity');

  const screenshotPromise = service.screenshot({ sender }, result.sessionId);
  const screenshotCommand = stdinLines.at(-1);
  assert.strictEqual(screenshotCommand.command, 'screenshot');
  assert.strictEqual(screenshotCommand.requestId, 'session-2');
  assert.strictEqual(path.dirname(screenshotCommand.path), screenshotRoot);
  assert.match(path.basename(screenshotCommand.path), /^\.camera\.session-2\.photoflow-transcode-screenshot\.png$/);
  const publicScreenshot = fs.readdirSync(screenshotRoot).find(name => name.startsWith('camera_截图_'));
  assert.strictEqual(publicScreenshot, undefined, 'the public screenshot must not appear while the component is writing');
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngIend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  fs.writeFileSync(screenshotCommand.path, Buffer.concat([pngSignature, Buffer.from('partial')]));
  child.stdout.write(`${JSON.stringify({ type: 'screenshot-result', requestId: screenshotCommand.requestId, success: true, path: screenshotCommand.path })}\n`);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(fs.readdirSync(screenshotRoot).some(name => name.startsWith('camera_截图_')), false, 'a partial PNG must remain hidden after a premature component success');
  fs.appendFileSync(screenshotCommand.path, pngIend);
  const screenshotResult = await screenshotPromise;
  assert.match(path.basename(screenshotResult.path), /^camera_截图_\d{8}-\d{6}-\d{3}_session-\.png$/);
  assert.equal(fs.existsSync(screenshotCommand.path), false, 'atomic publication must consume the internal temporary file');
  assert.equal(fs.existsSync(screenshotResult.path), true);

  const cleanupChildren = [];
  let cleanupUuid = 0;
  const cleanupService = createAdvancedVideoService({
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => `cleanup-${++cleanupUuid}` },
    mediaService: { authorizeInput: async value => path.resolve(value) },
    path,
    pluginService: { resolveRunConfigAsync: async () => ({ command: 'C:\\component\\advanced-video-decoder.exe', args: [] }) },
    spawn: () => {
      const cleanupChild = makeChild();
      cleanupChildren.push(cleanupChild);
      process.nextTick(() => cleanupChild.stdout.write('{"type":"ready"}\n'));
      return cleanupChild;
    },
    screenshotTimeoutMs: 120,
    screenshotProbeMs: 10,
    writeLog: () => undefined,
  });
  const cleanupSession = await cleanupService.start({ sender }, sourceVideo, 'seek', 'player-cleanup', 'request-cleanup');
  const failedCapture = cleanupService.screenshot({ sender }, cleanupSession.sessionId);
  const failedCommand = cleanupChildren[0].stdinLines.at(-1);
  fs.writeFileSync(failedCommand.path, 'partial');
  cleanupChildren[0].stdout.write(`${JSON.stringify({ type: 'screenshot-result', requestId: failedCommand.requestId, success: false, error: 'capture failed' })}\n`);
  await assert.rejects(failedCapture, /capture failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(failedCommand.path), false, 'component errors must clean the internal screenshot file');
  const timedOutCapture = cleanupService.screenshot({ sender }, cleanupSession.sessionId);
  const timedOutCommand = cleanupChildren[0].stdinLines.at(-1);
  fs.writeFileSync(timedOutCommand.path, 'partial');
  const timeoutKeepAlive = setTimeout(() => undefined, 250);
  await assert.rejects(timedOutCapture, /超时/);
  clearTimeout(timeoutKeepAlive);
  assert.equal(fs.existsSync(timedOutCommand.path), false, 'screenshot timeouts must clean the internal screenshot file');
  cleanupService.stop(cleanupSession.sessionId, sender.id);
  fs.rmSync(screenshotRoot, { recursive: true, force: true });

  const playerSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'components', 'AdvancedVideoPlayer.tsx'), 'utf8');
  const workspaceSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const systemIpcSource = require('fs').readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  const decoderSource = require('fs').readFileSync(path.join(__dirname, '..', 'extensions', 'video-playback-mpv', 'AdvancedVideoDecoder.cs'), 'utf8');
  const decoderBuildSource = require('fs').readFileSync(path.join(__dirname, 'build-advanced-video-decoder.cjs'), 'utf8');
  const runtimeBuildSource = require('fs').readFileSync(path.join(__dirname, 'media-runtime', 'build-libmpv-dependencies-windows.sh'), 'utf8');
  const libmpvBuildSource = require('fs').readFileSync(path.join(__dirname, 'media-runtime', 'build-libmpv-lgpl-windows.sh'), 'utf8');
  const settingsSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'features', 'settings', 'SettingsFeature.tsx'), 'utf8');
  const appSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
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
    && decoderBuildSource.includes('normalizeZipTimestamps')
    && decoderBuildSource.includes("new Set(['.dll', '.exe', '.json', '.md', '.txt', '.zip'])"),
  'advanced video packaging must use deterministic metadata, timestamps, and entry ordering');
  assert(!require('fs').existsSync(path.join(__dirname, '..', 'src', 'features', 'plugins', 'plugin-contributions.ts'))
    && settingsSource.includes("{ id: 'video', label: '视频'")
    && appSource.includes("delete componentSettings['video-playback-mpv']"),
  'advanced video UI and settings must ship with the app instead of the optional runtime');
  assert(decoderSource.includes('SetOption("vo", probeOnly ? "null" : "gpu")')
    && !decoderSource.includes('"gpu-next')
    && decoderSource.includes('SetOption("gpu-api", "d3d11")')
    && decoderSource.includes('SetOption("hwdec", "auto-safe")'),
  'advanced video playback must use the stable embedded D3D11 renderer with automatic CPU decoding fallback');
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
  assert(playerSource.includes('cyclePlaybackSpeed') && playerSource.includes("controlPanel === 'speed'") && playerSource.includes('absolute bottom-full') && playerSource.includes('PLAYBACK_SPEEDS.map') && playerSource.includes('captureVideoPlayerFrame'), 'video controls must expose a compact floating playback-speed panel, click-to-cycle speed, and current-frame capture');
  assert(playerSource.includes("controlPanel === 'volume'") && playerSource.includes('aria-label="调整音量"') && playerSource.includes("control('mute', !muted)"), 'volume must use a floating panel above its icon while icon clicks toggle mute');
  assert(playerSource.includes('overlayHole') && playerSource.includes('controlsOverlayHole') && playerSource.includes('cornerOverlayHole') && decoderSource.includes('controlsHoleWidth') && decoderSource.includes('ApplyOverlayHoles') && decoderSource.includes('path.AddEllipse(bounds)'), 'the native video surface must expose floating panels and controls with rectangular holes and the full-screen close button with a circular hole');
  assert(playerSource.includes('useHostSurfaceState') && playerSource.includes('!hostSurfaceSuspended') && !playerSource.includes('hasVisibleExternalModal') && !playerSource.includes('MutationObserver'), 'native video surfaces must consume explicit host suspension instead of guessing from modal DOM');
  assert(playerSource.includes('topRightOverlayHole') && !playerSource.includes('marginTop: Math.max(0, topOverlayInset)') && workspaceSource.includes('topRightOverlayHole={fullscreen && fullscreenControlsVisible ? 60 : 0}'), 'full-screen video must reach the top edge while keeping the close button interactive without exposing a rectangular patch');
  assert(playerSource.includes('controlsOverlay ? <div ref={controlsOverlayRef} className="absolute inset-x-0 bottom-0') && workspaceSource.includes('controlsVisible={!fullscreen || fullscreenControlsVisible}') && workspaceSource.includes('controlsOverlay={fullscreen}'), 'full-screen playback controls must float over a full-size video surface, hide with the close button, and return on pointer activity');
  assert(decoderSource.includes('eventArgs.Location == lastPointerLocation'), 'native video pointer activity must ignore repeated events at the same coordinates so full-screen controls can time out');
  assert(workspaceSource.includes('FULLSCREEN_CONTROLS_HIDE_DELAY_MS = 1800'), 'full-screen media controls must hide after exactly 1.8 seconds of inactivity');
  assert(workspaceSource.includes('projectWorkspaceClient.setWindowFullscreen(true)') && workspaceSource.includes('projectWorkspaceClient.setWindowFullscreen(false)') && systemIpcSource.includes("setAlwaysOnTop(true, 'screen-saver', 1)") && systemIpcSource.includes('targetWindow.setKiosk(true)') && systemIpcSource.includes('targetWindow.focus()'), 'media preview full-screen must focus a Windows kiosk window above the taskbar without requiring a follow-up click');
  assert(!playerSource.includes('title="单击播放或暂停"'), 'the video surface must not show a redundant hover tooltip for its click action');
  assert(!workspaceSource.includes('autoPlay controls') && workspaceSource.includes('不会改用 Chromium 播放'), 'advanced playback failures must not silently switch to a divergent Chromium decoder path');
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
