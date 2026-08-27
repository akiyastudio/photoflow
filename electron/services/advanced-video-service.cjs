const { StringDecoder } = require('string_decoder');
const fs = require('fs');

const START_TIMEOUT_MS = 8000;
const SCREENSHOT_TIMEOUT_MS = 8000;
const SCREENSHOT_PROBE_MS = 40;
const CLIENT_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,96}$/;
const DEFAULT_SUBTITLE_FONT_SIZE = 55;
const normalizeSubtitleFontSize = value => {
  const migrated = value === 'large' ? 74 : value === 'default' ? DEFAULT_SUBTITLE_FONT_SIZE : Number(value);
  return Number.isFinite(migrated) ? Math.max(16, Math.min(120, Math.round(migrated))) : DEFAULT_SUBTITLE_FONT_SIZE;
};

const nativeWindowHandleValue = window => {
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) throw new Error('无法读取照片流窗口句柄');
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
};

const createAdvancedVideoService = ({
  BrowserWindow, crypto, mediaService, path, playbackBroker, processSupervisor = null, spawn, writeLog,
  fileSystem = fs, screenshotTimeoutMs = SCREENSHOT_TIMEOUT_MS, screenshotProbeMs = SCREENSHOT_PROBE_MS,
}) => {
  const sessions = new Map();
  const sessionsByPlayer = new Map();
  const launches = new Map();

  const playerKey = (senderId, playerId) => `${senderId}:${playerId}`;
  const unlinkScreenshotTemporary = pending => fileSystem.promises.unlink(pending.temporaryPath).catch(() => undefined);
  const rejectPendingScreenshot = (session, requestId, pending, error, allowPublishing = false) => {
    if (session.pendingScreenshots.get(requestId) !== pending) return;
    if (pending.phase === 'publishing' && !allowPublishing) return;
    session.pendingScreenshots.delete(requestId);
    clearTimeout(pending.timer);
    pending.phase = 'settled';
    pending.cancelled = true;
    void unlinkScreenshotTemporary(pending).finally(() => pending.reject(error));
  };
  const isCompletePng = async filePath => {
    let handle;
    try {
      const stat = await fileSystem.promises.stat(filePath);
      if (!stat.isFile() || stat.size < 20) return false;
      handle = await fileSystem.promises.open(filePath, 'r');
      const signature = Buffer.alloc(8);
      const trailer = Buffer.alloc(12);
      await handle.read(signature, 0, signature.length, 0);
      await handle.read(trailer, 0, trailer.length, stat.size - trailer.length);
      return signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && trailer.readUInt32BE(0) === 0 && trailer.subarray(4, 8).toString('ascii') === 'IEND';
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
  const publishScreenshot = async pending => {
    while (!pending.cancelled && Date.now() < pending.deadlineAt) {
      if (await isCompletePng(pending.temporaryPath)) {
        if (pending.cancelled || pending.phase !== 'waiting') throw new Error('视频截图发布已取消');
        // This synchronous state transition is the commit boundary. Once the
        // same-directory rename has started, timeout/stop must not report a
        // failure that could be followed by a visible public file.
        pending.phase = 'publishing';
        clearTimeout(pending.timer);
        await fileSystem.promises.rename(pending.temporaryPath, pending.finalPath);
        return pending.finalPath;
      }
      await new Promise(resolve => setTimeout(resolve, screenshotProbeMs));
    }
    if (pending.cancelled) throw new Error('视频截图发布已取消');
    throw new Error('视频截图文件在超时前未完整写入');
  };
  const removeSession = session => {
    sessions.delete(session.id);
    const key = playerKey(session.sender.id, session.playerId);
    if (sessionsByPlayer.get(key) === session.id) sessionsByPlayer.delete(key);
    if (launches.get(key) === session.requestId) launches.delete(key);
  };

  const emit = (session, value) => {
    if (!session.sender.isDestroyed()) {
      const payload = { ...value, sessionId: session.id, playerId: session.playerId, requestId: session.requestId };
      session.sender.send('video-player-state', payload);
      // Legacy boundary: older installed renderers listen on this channel.
      session.sender.send('advanced-video-state', payload);
    }
  };

  const sendCommand = (session, value) => {
    if (!session || session.stopped || !session.child.stdin.writable) return false;
    try {
      session.child.stdin.write(`${JSON.stringify(value)}\n`);
      return true;
    } catch (error) {
      writeLog('warn', 'Unable to control advanced video decoder', { sessionId: session.id, error: error.message || String(error) });
      return false;
    }
  };

  const stop = (sessionId, senderId) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || senderId !== undefined && session.sender.id !== senderId) return false;
    removeSession(session);
    emit(session, { type: 'stopped' });
    session.stopped = true;
    if (session.rejectReady) {
      session.rejectReady(new Error('视频播放启动已取消'));
      session.rejectReady = null;
    }
    if (session.onSenderDestroyed) {
      session.sender.removeListener('destroyed', session.onSenderDestroyed);
      session.onSenderDestroyed = null;
    }
    for (const pending of session.pendingScreenshots.values()) {
      rejectPendingScreenshot(session, pending.requestId, pending, new Error('视频播放已经停止'));
    }
    try { session.child.stdin.end(`${JSON.stringify({ command: 'close' })}\n`); } catch { /* process already exited */ }
    const timer = setTimeout(() => {
      if (session.managedProcess) session.managedProcess.stop('advanced-video-stop');
      else if (!session.child.killed) session.child.kill();
    }, 1200);
    timer.unref?.();
    return true;
  };

  const stopForPlayer = (senderId, playerId) => {
    const id = sessionsByPlayer.get(playerKey(senderId, playerId));
    if (id) stop(id, senderId);
  };

  const start = async (event, filePath, requestedSettings = {}, playerId, requestId, requestedBackendId = '') => {
    const settings = typeof requestedSettings === 'string'
      ? { arrowKeyAction: requestedSettings }
      : requestedSettings && typeof requestedSettings === 'object' ? requestedSettings : {};
    const sender = event.sender;
    const normalizedPlayerId = String(playerId || '');
    const normalizedRequestId = String(requestId || '');
    if (!CLIENT_TOKEN_PATTERN.test(normalizedPlayerId) || !CLIENT_TOKEN_PATTERN.test(normalizedRequestId)) throw new Error('视频播放器请求标识无效');
    const key = playerKey(sender.id, normalizedPlayerId);
    launches.set(key, normalizedRequestId);
    stopForPlayer(sender.id, normalizedPlayerId);
    const assertCurrentLaunch = () => {
      if (launches.get(key) !== normalizedRequestId) throw new Error('视频播放器请求已被替换');
    };
    let session = null;

    try {
      const authorizedPath = await mediaService.authorizeInput(filePath);
      assertCurrentLaunch();
      const ownerWindow = BrowserWindow.fromWebContents(sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error('照片流窗口已经关闭');
      const backendId = String(requestedBackendId || playbackBroker.defaultBackendId());
      if (!backendId) throw new Error('没有可用的高级视频播放后端');
      const runConfig = await playbackBroker.resolveRunConfigAsync(backendId, ['--parent-hwnd', nativeWindowHandleValue(ownerWindow)]);
      assertCurrentLaunch();
      const id = crypto.randomUUID();
      const managedProcess = processSupervisor?.launch({
        id: `component:advanced-video:${id}`,
        kind: 'optional-component',
        command: runConfig.command,
        args: runConfig.args,
        options: { cwd: path.dirname(runConfig.command), stdio: ['pipe', 'pipe', 'pipe'] },
        health: { startupTimeoutMs: START_TIMEOUT_MS },
        ephemeral: true,
      });
      const child = managedProcess?.child || spawn(runConfig.command, runConfig.args, {
        cwd: path.dirname(runConfig.command), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      session = {
        id,
        sender,
        child,
        managedProcess,
        playerId: normalizedPlayerId,
        requestId: normalizedRequestId,
        filePath: authorizedPath,
        stopped: false,
        ready: false,
        lastError: '',
        pendingScreenshots: new Map(),
        onSenderDestroyed: null,
        rejectReady: null,
      };
      sessions.set(id, session);
      sessionsByPlayer.set(key, id);
      session.onSenderDestroyed = () => stop(id, sender.id);
      sender.once('destroyed', session.onSenderDestroyed);

      const decoder = new StringDecoder('utf8');
      let buffered = '';
      let settleReady;
      let rejectReady;
      const readyPromise = new Promise((resolve, reject) => {
        settleReady = resolve;
        rejectReady = reject;
        session.rejectReady = reject;
      });
      const startupTimer = setTimeout(() => rejectReady(new Error('视频播放器启动超时，请在组件管理中修复或重新安装视频播放器运行时')), START_TIMEOUT_MS);
      startupTimer.unref?.();

      const consumeLine = line => {
        if (session.stopped || !line.trim()) return;
        let value;
        try { value = JSON.parse(line); }
        catch {
          writeLog('warn', 'Advanced video decoder emitted invalid JSON', { line: line.slice(0, 500) });
          return;
        }
        if (value.type === 'screenshot-result') {
          const screenshotRequestId = String(value.requestId || '');
          const pending = session.pendingScreenshots.get(screenshotRequestId);
          if (!pending) return;
          if (pending.componentCompleted) return;
          if (!value.success) {
            rejectPendingScreenshot(session, screenshotRequestId, pending, new Error(String(value.error || '无法保存当前视频帧')));
            return;
          }
          pending.componentCompleted = true;
          void publishScreenshot(pending).then(finalPath => {
            if (session.pendingScreenshots.get(screenshotRequestId) !== pending) return;
            session.pendingScreenshots.delete(screenshotRequestId);
            clearTimeout(pending.timer);
            pending.phase = 'settled';
            pending.resolve({ path: finalPath });
          }, error => rejectPendingScreenshot(session, screenshotRequestId, pending, error, true));
          return;
        }
        if (value.type === 'ready') {
          session.ready = true;
          session.managedProcess?.markHealthy({ protocol: 'video-player-v1' });
          session.rejectReady = null;
          clearTimeout(startupTimer);
          settleReady();
        } else if (value.type === 'fatal') {
          session.lastError = String(value.error || '视频播放器启动失败');
          clearTimeout(startupTimer);
          rejectReady(new Error(session.lastError));
        }
        emit(session, value);
      };
      child.stdout.on('data', chunk => {
        buffered += decoder.write(chunk);
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, '');
          buffered = buffered.slice(newline + 1);
          consumeLine(line);
        }
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
      child.once('error', error => {
        session.lastError = error.message || String(error);
        clearTimeout(startupTimer);
        rejectReady(error);
        if (!session.stopped) emit(session, { type: 'fatal', error: session.lastError });
      });
      child.once('exit', code => {
        clearTimeout(startupTimer);
        for (const [requestId, pending] of session.pendingScreenshots.entries()) {
          rejectPendingScreenshot(session, requestId, pending, new Error('视频播放器在截图完成前退出'));
        }
        removeSession(session);
        if (!session.ready) rejectReady(new Error(session.lastError || stderr.trim() || `视频播放器退出（${code ?? '未知'}），请修复或重新安装视频播放器运行时`));
        else if (!session.stopped) emit(session, { type: 'fatal', error: session.lastError || stderr.trim() || '视频播放器意外退出，请重新打开视频；若持续失败请修复视频播放器运行时' });
        writeLog(code === 0 || session.stopped ? 'info' : 'warn', 'Advanced video decoder exited', { sessionId: id, code, error: stderr.trim() });
      });

      await readyPromise;
      assertCurrentLaunch();
      if (!sendCommand(session, { command: 'open', path: authorizedPath })) throw new Error('无法向视频播放器发送文件');
      sendCommand(session, { command: 'subtitle-style', fontSize: normalizeSubtitleFontSize(settings.subtitleSize), style: settings.subtitleStyle === 'high-contrast' ? 'high-contrast' : 'standard' });
      if (!sendCommand(session, { command: 'play' })) throw new Error('无法启动视频播放器');
      writeLog('info', 'Advanced video decoder started', { sessionId: id, filePath: authorizedPath });
      return { sessionId: id, playerId: normalizedPlayerId, requestId: normalizedRequestId };
    } catch (error) {
      if (session) stop(session.id, sender.id);
      else if (launches.get(key) === normalizedRequestId) launches.delete(key);
      throw error;
    }
  };

  const setBounds = (event, sessionId, bounds = {}) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.sender.id !== event.sender.id) return;
    const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
    const width = Math.max(0, Math.min(32768, number(bounds.width)));
    const height = Math.max(0, Math.min(32768, number(bounds.height)));
    const requestedHole = bounds.overlayHole && typeof bounds.overlayHole === 'object' ? bounds.overlayHole : {};
    const holeX = Math.max(0, Math.min(width, number(requestedHole.x)));
    const holeY = Math.max(0, Math.min(height, number(requestedHole.y)));
    const holeWidth = Math.max(0, Math.min(width - holeX, number(requestedHole.width)));
    const holeHeight = Math.max(0, Math.min(height - holeY, number(requestedHole.height)));
    const requestedControlsHole = bounds.controlsOverlayHole && typeof bounds.controlsOverlayHole === 'object' ? bounds.controlsOverlayHole : {};
    const controlsHoleX = Math.max(0, Math.min(width, number(requestedControlsHole.x)));
    const controlsHoleY = Math.max(0, Math.min(height, number(requestedControlsHole.y)));
    const controlsHoleWidth = Math.max(0, Math.min(width - controlsHoleX, number(requestedControlsHole.width)));
    const controlsHoleHeight = Math.max(0, Math.min(height - controlsHoleY, number(requestedControlsHole.height)));
    const requestedCornerHole = bounds.cornerOverlayHole && typeof bounds.cornerOverlayHole === 'object' ? bounds.cornerOverlayHole : {};
    const cornerHoleX = Math.max(0, Math.min(width, number(requestedCornerHole.x)));
    const cornerHoleY = Math.max(0, Math.min(height, number(requestedCornerHole.y)));
    const cornerHoleWidth = Math.max(0, Math.min(width - cornerHoleX, number(requestedCornerHole.width)));
    const cornerHoleHeight = Math.max(0, Math.min(height - cornerHoleY, number(requestedCornerHole.height)));
    sendCommand(session, {
      command: 'set-bounds',
      x: Math.max(-32768, Math.min(32768, number(bounds.x))),
      y: Math.max(-32768, Math.min(32768, number(bounds.y))),
      width,
      height,
      visible: Boolean(bounds.visible) && width > 1 && height > 1,
      holeX,
      holeY,
      holeWidth,
      holeHeight,
      controlsHoleX,
      controlsHoleY,
      controlsHoleWidth,
      controlsHoleHeight,
      cornerHoleX,
      cornerHoleY,
      cornerHoleWidth,
      cornerHoleHeight,
    });
  };

  const control = (event, sessionId, request = {}) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.sender.id !== event.sender.id) return;
    const allowed = new Set(['play', 'pause', 'seek', 'volume', 'mute', 'speed', 'stop', 'subtitle-select', 'subtitle-visible', 'subtitle-delay', 'subtitle-style']);
    const command = String(request.action || '');
    if (!allowed.has(command)) return;
    sendCommand(session, {
      command,
      value: request.value,
      fontSize: command === 'subtitle-style' ? normalizeSubtitleFontSize(request.fontSize ?? request.size) : undefined,
      style: request.style,
    });
  };

  const ownsSession = (sessionId, senderId) => {
    const session = sessions.get(String(sessionId || ''));
    return Boolean(session && !session.stopped && session.sender.id === senderId);
  };

  const addSubtitle = (event, sessionId, filePath) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.stopped || session.sender.id !== event.sender.id) throw new Error('视频播放会话不存在');
    if (!['.srt', '.ass', '.ssa', '.vtt'].includes(path.extname(filePath).toLowerCase())) throw new Error('仅支持 SRT、ASS、SSA 和 VTT 字幕');
    if (!sendCommand(session, { command: 'subtitle-add', path: filePath })) throw new Error('无法向视频播放器添加字幕');
  };

  const screenshot = async (event, sessionId) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.sender.id !== event.sender.id || session.stopped) throw new Error('视频播放会话不存在');
    const requestId = crypto.randomUUID();
    const now = new Date();
    const two = value => String(value).padStart(2, '0');
    const three = value => String(value).padStart(3, '0');
    const timestamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}-${three(now.getMilliseconds())}`;
    const parsed = path.parse(session.filePath);
    const targetPath = path.join(parsed.dir, `${parsed.name}_截图_${timestamp}_${requestId.slice(0, 8)}.png`);
    const temporaryPath = path.join(parsed.dir, `.${parsed.name}.${requestId}.photoflow-transcode-screenshot.png`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = session.pendingScreenshots.get(requestId);
        if (pending) rejectPendingScreenshot(session, requestId, pending, new Error('保存当前视频帧超时'));
      }, screenshotTimeoutMs);
      timer.unref?.();
      const pending = {
        requestId, resolve, reject, timer, finalPath: targetPath, temporaryPath,
        deadlineAt: Date.now() + screenshotTimeoutMs, componentCompleted: false,
        cancelled: false, phase: 'waiting',
      };
      session.pendingScreenshots.set(requestId, pending);
      if (!sendCommand(session, { command: 'screenshot', requestId, path: temporaryPath })) {
        rejectPendingScreenshot(session, requestId, pending, new Error('无法向视频解码组件发送截图命令'));
      }
    });
  };

  const dispose = () => {
    for (const session of [...sessions.values()]) stop(session.id);
  };

  return { start, setBounds, control, addSubtitle, ownsSession, screenshot, stop, dispose, sessions, sessionsByPlayer, launches };
};

module.exports = { createAdvancedVideoService, nativeWindowHandleValue };
