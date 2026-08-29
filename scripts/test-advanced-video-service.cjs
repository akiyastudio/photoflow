const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const { PassThrough } = require('stream');
const path = require('path');
const { createVideoPlaybackProcessService: createAdvancedVideoService } = require('../electron/services/video-playback-process-service.cjs');
const { nativeHandleValue: nativeWindowHandleValue } = require('../electron/services/native-video-surface-service.cjs');
const { createPlaybackCaptureService } = require('../electron/services/playback-capture-service.cjs');
const { readPeDependencies } = require('../plugins/video-playback-backend/scripts/vendor/pe-dependency-closure.cjs');
const { LEGACY_COMMAND_TO_V1 } = require('../electron/services/media-playback-process-adapter.cjs');
const v1ToLegacyCommand = Object.fromEntries(Object.entries(LEGACY_COMMAND_TO_V1).map(([legacy, semantic]) => [semantic, legacy]));
const backendEventNames = { ready: 'runtime.ready', 'surface-created': 'surface.created', state: 'state.changed', 'screenshot-result': 'capture.completed' };
const backendEvent = (sessionId, sequence, type, payload = {}) => `${JSON.stringify({ protocol: 'media-playback-backend-v1', protocolVersion: 1, sessionId, sequence, timestamp: Date.now(), event: `event.${backendEventNames[type] || type}`, payload })}\n`;
const backendStartup = sessionId => backendEvent(sessionId, 1, 'surface-created', { surfaceHandle: '4242', processId: 123 }) + backendEvent(sessionId, 2, 'ready');
const makeMediaInputs = (authorize = async value => path.resolve(value)) => { const pending = new Map(), grants = new Map(); return { prepare: async request => { pending.set(request.sessionId, { ...request, authorizedPath: await authorize(request.filePath) }); }, bindProcess: request => { const value = pending.get(request.sessionId); pending.delete(request.sessionId); const token = `input-token-${request.sessionId}`; grants.set(token, { ...value, ...request }); return { token }; }, resolve: async token => grants.get(token).authorizedPath, revoke: value => { pending.delete(value); for (const [token, grant] of grants) if (token === value || grant.sessionId === value) grants.delete(token); } }; };
const makeCaptures = (fileSystem = fs) => { let id = 0; return createPlaybackCaptureService({ crypto: { randomUUID: () => `capture-stage-${++id}` }, fs: fileSystem, path, authorizeProjectMedia: async value => path.resolve(value) }); };

const makeChild = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  child.stdinLines = [];
  child.stdin.on('data', chunk => child.stdinLines.push(...chunk.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(line => { const envelope = JSON.parse(line), semantic = envelope.event.slice('command.'.length); return { command: v1ToLegacyCommand[semantic] || semantic, ...envelope.payload }; })));
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
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
  const surfaceBounds = [];
  let uuidIndex = 0;
  const service = createAdvancedVideoService({
    captureService: makeCaptures(),
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => `session-${++uuidIndex}` },
    mediaInputSessionService: makeMediaInputs(),
    nativeSurfaceService: { attach: async () => ({ setBounds: value => surfaceBounds.push(value), close: () => undefined }) },
    path,
    playbackBroker: { defaultBackendId: () => 'fixture-backend',
      resolveRunConfigAsync: async (_id, args) => ({ command: 'C:\\component\\fixture-playback-backend.exe', args }),
    },
    spawn: (command, args, options) => {
      const child = makeChild();
      children.push(child);
      spawned.push({ command, args, options });
      const sessionId = args[args.indexOf('--session-id') + 1];
      process.nextTick(() => child.stdout.write(backendStartup(sessionId) + backendEvent(sessionId, 3, 'state', { time: 2, duration: 10, paused: false, buffering: false })));
      return child;
    },
    writeLog: () => undefined,
  });

  const result = await service.start({ sender }, sourceVideo, 'navigate', 'player-one', 'request-one');
  const child = children[0];
  const stdinLines = child.stdinLines;
  assert.strictEqual(result.sessionId, 'session-1');
  assert.strictEqual(spawned[0].options.windowsHide, true);
  assert.deepStrictEqual(spawned[0].args, ['--session-id', 'session-1']);
  assert.deepStrictEqual(stdinLines[0], { command: 'open', path: path.resolve(sourceVideo) });
  assert.deepStrictEqual(stdinLines[1], { command: 'subtitle-style', fontSize: 55, style: 'standard' });
  assert.deepStrictEqual(stdinLines[2], { command: 'play' });

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
  assert.deepStrictEqual(surfaceBounds[0], {
    x: 10, y: 21, width: 300, height: 201, visible: true,
    holeX: 210, holeY: 80, holeWidth: 90, holeHeight: 121,
    controlsHoleX: 0, controlsHoleY: 150, controlsHoleWidth: 300, controlsHoleHeight: 51,
    cornerHoleX: 240, cornerHoleY: 0, cornerHoleWidth: 60, cornerHoleHeight: 72,
  });
  assert.deepStrictEqual(stdinLines[3], { command: 'play' });
  assert.deepStrictEqual(stdinLines.slice(4), [
    { command: 'subtitle-select', value: '3' },
    { command: 'subtitle-visible', value: false },
    { command: 'subtitle-delay', value: 1.5 },
    { command: 'subtitle-style', fontSize: 73, style: 'high-contrast' },
  ]);
  assert.strictEqual(stdinLines.length, 8, 'only allowlisted commands from the owning renderer may reach the native session');

  assert(sender.sent.some(item => item.channel === 'advanced-video-state'
    && item.value.sessionId === 'session-1'
    && item.value.playerId === 'player-one'
    && item.value.requestId === 'request-one'
    && item.value.time === 2), 'state emitted before start resolves must retain the renderer-known request identity');

  const screenshotPromise = service.screenshot({ sender }, result.sessionId);
  await new Promise(resolve => setImmediate(resolve));
  const screenshotCommand = stdinLines.at(-1);
  assert.strictEqual(screenshotCommand.command, 'screenshot');
  assert.strictEqual(screenshotCommand.requestId, 'session-2');
  assert.strictEqual(screenshotCommand.captureMode, 'displayedFrame');
  assert.strictEqual(path.dirname(screenshotCommand.path), screenshotRoot);
  assert.match(path.basename(screenshotCommand.path), /^\.camera\.capture-stage-1\.photoflow-capture-stage\.png$/);
  const publicScreenshot = fs.readdirSync(screenshotRoot).find(name => name.startsWith('camera_截图_'));
  assert.strictEqual(publicScreenshot, undefined, 'the public screenshot must not appear while the component is writing');
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngIend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  fs.writeFileSync(screenshotCommand.path, Buffer.concat([pngSignature, Buffer.from('partial')]));
  child.stdout.write(backendEvent('session-1', 4, 'screenshot-result', { requestId: screenshotCommand.requestId, success: true, path: screenshotCommand.path }));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(fs.readdirSync(screenshotRoot).some(name => name.startsWith('camera_截图_')), false, 'a partial PNG must remain hidden after a premature component success');
  fs.appendFileSync(screenshotCommand.path, pngIend);
  const screenshotResult = await screenshotPromise;
  assert.match(path.basename(screenshotResult.path), /^camera_截图_\d{8}-\d{6}-\d{3}_capture-\.png$/);
  assert.equal(fs.existsSync(screenshotCommand.path), false, 'atomic publication must consume the internal temporary file');
  assert.equal(fs.existsSync(screenshotResult.path), true);

  const cleanupChildren = [];
  let cleanupUuid = 0;
  const cleanupService = createAdvancedVideoService({
    captureService: makeCaptures(),
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => `cleanup-${++cleanupUuid}` },
    mediaInputSessionService: makeMediaInputs(),
    nativeSurfaceService: { attach: async () => ({ setBounds: () => undefined, close: () => undefined }) },
    path,
    playbackBroker: { defaultBackendId: () => 'fixture-backend', resolveRunConfigAsync: async (_id, args) => ({ command: 'C:\\component\\fixture-playback-backend.exe', args }) },
    spawn: (_command, args) => {
      const cleanupChild = makeChild();
      cleanupChildren.push(cleanupChild);
      process.nextTick(() => cleanupChild.stdout.write(backendStartup(args[args.indexOf('--session-id') + 1])));
      return cleanupChild;
    },
    screenshotTimeoutMs: 120,
    screenshotProbeMs: 10,
    writeLog: () => undefined,
  });
  const cleanupSession = await cleanupService.start({ sender }, sourceVideo, 'seek', 'player-cleanup', 'request-cleanup');
  const failedCapture = cleanupService.screenshot({ sender }, cleanupSession.sessionId);
  await new Promise(resolve => setImmediate(resolve));
  const failedCommand = cleanupChildren[0].stdinLines.at(-1);
  fs.writeFileSync(failedCommand.path, 'partial');
  cleanupChildren[0].stdout.write(backendEvent('cleanup-1', 3, 'screenshot-result', { requestId: failedCommand.requestId, success: false, error: 'capture failed' }));
  await assert.rejects(failedCapture, /capture failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(failedCommand.path), false, 'component errors must clean the internal screenshot file');
  const timedOutCapture = cleanupService.screenshot({ sender }, cleanupSession.sessionId);
  await new Promise(resolve => setImmediate(resolve));
  const timedOutCommand = cleanupChildren[0].stdinLines.at(-1);
  fs.writeFileSync(timedOutCommand.path, 'partial');
  const timeoutKeepAlive = setTimeout(() => undefined, 250);
  await assert.rejects(timedOutCapture, /超时/);
  clearTimeout(timeoutKeepAlive);
  assert.equal(fs.existsSync(timedOutCommand.path), false, 'screenshot timeouts must clean the internal screenshot file');
  cleanupService.stop(cleanupSession.sessionId, sender.id);
  fs.rmSync(screenshotRoot, { recursive: true, force: true });

  const timeoutChild = makeChild();
  const timeoutService = createAdvancedVideoService({ BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) }, captureService: makeCaptures(), crypto: { randomUUID: () => 'session-timeout' }, mediaInputSessionService: makeMediaInputs(), nativeSurfaceService: { attach: async () => ({ setBounds() {}, close() {} }) }, path, playbackBroker: { defaultBackendId: () => 'fixture-backend', ownerForBackend: () => ({ componentId: 'fixture-component' }), resolveRunConfigAsync: async (_id, args) => ({ command: 'fixture.exe', args }) }, spawn: () => timeoutChild, startupTimeoutMs: 20, writeLog() {} });
  const startupTimeoutKeepAlive = setTimeout(() => undefined, 100);
  await assert.rejects(timeoutService.start({ sender }, 'C:\\workspace\\timeout.mov', {}, 'player-timeout', 'request-timeout'), /超时/);
  clearTimeout(startupTimeoutKeepAlive);

  const playerSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'components', 'AdvancedVideoPlayer.tsx'), 'utf8');
  const workspaceSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const systemIpcSource = require('fs').readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  const nativeSurfaceHostSource = require('fs').readFileSync(path.join(__dirname, '..', 'electron', 'native', 'VideoSurfaceHost.cs'), 'utf8');
  const settingsSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'features', 'settings', 'SettingsFeature.tsx'), 'utf8');
  const appSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  const compatibilitySource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'compatibility', 'legacy-video-playback-settings.ts'), 'utf8');
  assert(!require('fs').existsSync(path.join(__dirname, '..', 'src', 'features', 'plugins', 'plugin-contributions.ts'))
    && settingsSource.includes("{ id: 'video', label: '视频'")
    && appSource.includes('delete componentSettings[LEGACY_VIDEO_PLAYBACK_SETTINGS_ID]')
    && compatibilitySource.includes("'video-playback-mpv'"),
  'advanced video UI and settings must ship with the app instead of the optional runtime');
  assert(playerSource.includes('onClick={togglePlayback}') && !playerSource.includes("key === 'BrowserBack'") && !playerSource.includes("key === 'MediaTrackPrevious'"), 'application player must own click semantics without repurposing browser/media keys');
  assert(playerSource.includes("group === 'arrows'") && playerSource.includes("return arrowKeyAction === 'navigate' ? 'seek' : 'navigate'") && playerSource.includes("videoDirectionalAction(keyboardSettings.arrowKeyAction, 'forward-back')"), 'application player must resolve seek versus navigation');
  assert(playerSource.includes('backwardControlLabel') && playerSource.includes('forwardControlLabel') && playerSource.includes('runForwardBackControl(-1)') && playerSource.includes('runForwardBackControl(1)'), 'the controls beside play/pause must expose their active seek or navigation behavior');
  assert(playerSource.includes('cyclePlaybackSpeed') && playerSource.includes("controlPanel === 'speed'") && playerSource.includes('absolute bottom-full') && playerSource.includes('PLAYBACK_SPEEDS.map') && playerSource.includes('currentSession.capture()'), 'video controls must expose a compact floating playback-speed panel, click-to-cycle speed, and backend-neutral current-frame capture');
  assert(playerSource.includes("controlPanel === 'volume'") && playerSource.includes('aria-label="调整音量"') && playerSource.includes("control('mute', !muted)"), 'volume must use a floating panel above its icon while icon clicks toggle mute');
  assert(playerSource.includes('overlayHole') && playerSource.includes('controlsOverlayHole') && playerSource.includes('cornerOverlayHole') && nativeSurfaceHostSource.includes('"controlsHole"') && nativeSurfaceHostSource.includes('CreateEllipticRgn'), 'the host-owned native surface must expose rectangular controls holes and a circular close-button hole');
  assert(playerSource.includes('useHostSurfaceState') && playerSource.includes('!hostSurfaceSuspended') && !playerSource.includes('hasVisibleExternalModal') && !playerSource.includes('MutationObserver'), 'native video surfaces must consume explicit host suspension instead of guessing from modal DOM');
  assert(playerSource.includes('topRightOverlayHole') && !playerSource.includes('marginTop: Math.max(0, topOverlayInset)') && workspaceSource.includes('topRightOverlayHole={fullscreen && fullscreenControlsVisible ? 60 : 0}'), 'full-screen video must reach the top edge while keeping the close button interactive without exposing a rectangular patch');
  assert(playerSource.includes('controlsOverlay ? <div ref={controlsOverlayRef} className="absolute inset-x-0 bottom-0') && workspaceSource.includes('controlsVisible={!fullscreen || fullscreenControlsVisible}') && workspaceSource.includes('controlsOverlay={fullscreen}'), 'full-screen playback controls must float over a full-size video surface, hide with the close button, and return on pointer activity');
  assert(workspaceSource.includes('FULLSCREEN_CONTROLS_HIDE_DELAY_MS = 1800'), 'full-screen media controls must hide after exactly 1.8 seconds of inactivity');
  assert(workspaceSource.includes('projectWorkspaceClient.setWindowFullscreen(true)') && workspaceSource.includes('projectWorkspaceClient.setWindowFullscreen(false)') && systemIpcSource.includes("setAlwaysOnTop(true, 'screen-saver', 1)") && systemIpcSource.includes('targetWindow.setKiosk(true)') && systemIpcSource.includes('targetWindow.focus()'), 'media preview full-screen must focus a Windows kiosk window above the taskbar without requiring a follow-up click');
  assert(!playerSource.includes('title="单击播放或暂停"'), 'the video surface must not show a redundant hover tooltip for its click action');
  assert(!workspaceSource.includes('不会改用 Chromium 播放') && playerSource.includes('startPlaybackSession'), 'formal playback failures must be resolved by the application-owned backend session instead of forbidding Chromium fallback');
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
  assert.strictEqual(children[2].stdin.writableEnded, true);

  const pendingAuthorization = new Map();
  const raceChildren = [];
  const raceService = createAdvancedVideoService({
    captureService: makeCaptures(),
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => 'session-race' },
    mediaInputSessionService: makeMediaInputs(value => new Promise(resolve => pendingAuthorization.set(value, resolve))),
    nativeSurfaceService: { attach: async () => ({ setBounds: () => undefined, close: () => undefined }) },
    path,
    playbackBroker: { defaultBackendId: () => 'fixture-backend', resolveRunConfigAsync: async (_id, args) => ({ command: 'C:\\component\\fixture-playback-backend.exe', args }) },
    spawn: (_command, args) => {
      const raceChild = makeChild();
      raceChildren.push(raceChild);
      process.nextTick(() => raceChild.stdout.write(backendStartup(args[args.indexOf('--session-id') + 1])));
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
  let integrityUuid = 0;
  const integrityRaceService = createAdvancedVideoService({
    captureService: makeCaptures(),
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
    crypto: { randomUUID: () => `session-integrity-race-${++integrityUuid}` },
    mediaInputSessionService: makeMediaInputs(),
    nativeSurfaceService: { attach: async () => ({ setBounds: () => undefined, close: () => undefined }) },
    path,
    playbackBroker: { defaultBackendId: () => 'fixture-backend', resolveRunConfigAsync: (_id, args) => new Promise(resolve => pendingRunConfigs.push(config => resolve({ ...config, args }))) },
    spawn: (_command, args) => {
      const child = makeChild();
      integrityRaceChildren.push(child);
      process.nextTick(() => child.stdout.write(backendStartup(args[args.indexOf('--session-id') + 1])));
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
  pendingRunConfigs[0]({ command: 'C:\\component\\fixture-playback-backend.exe', args: [] });
  const staleIntegrityError = await staleIntegrityStart;
  assert.match(staleIntegrityError?.message || '', /已被替换/);
  assert.strictEqual(integrityRaceChildren.length, 0, 'a superseded launch must not spawn after integrity verification finishes');
  pendingRunConfigs[1]({ command: 'C:\\component\\fixture-playback-backend.exe', args: [] });
  const currentIntegrity = await currentIntegrityStart;
  assert.strictEqual(integrityRaceChildren.length, 1);
  integrityRaceService.stop(currentIntegrity.sessionId, sender.id);

  console.log('Advanced video service tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
