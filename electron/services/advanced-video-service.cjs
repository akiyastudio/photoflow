const { StringDecoder } = require('string_decoder');

const COMPONENT_ID = 'video-playback-mpv';
const START_TIMEOUT_MS = 8000;
const SCREENSHOT_TIMEOUT_MS = 8000;

const nativeWindowHandleValue = window => {
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) throw new Error('无法读取照片流窗口句柄');
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
};

const createAdvancedVideoService = ({ BrowserWindow, crypto, mediaService, path, pluginService, spawn, writeLog }) => {
  const sessions = new Map();

  const emit = (session, value) => {
    if (!session.sender.isDestroyed()) session.sender.send('advanced-video-state', { sessionId: session.id, ...value });
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
    sessions.delete(session.id);
    session.stopped = true;
    if (session.onSenderDestroyed) {
      session.sender.removeListener('destroyed', session.onSenderDestroyed);
      session.onSenderDestroyed = null;
    }
    for (const pending of session.pendingScreenshots.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('视频播放已经停止'));
    }
    session.pendingScreenshots.clear();
    try { session.child.stdin.end(`${JSON.stringify({ command: 'close' })}\n`); } catch { /* process already exited */ }
    const timer = setTimeout(() => {
      if (!session.child.killed) session.child.kill();
    }, 1200);
    timer.unref?.();
    return true;
  };

  const stopForSender = senderId => {
    for (const session of [...sessions.values()]) if (session.sender.id === senderId) stop(session.id, senderId);
  };

  const start = async (event, filePath, arrowKeyAction = 'seek') => {
    const sender = event.sender;
    stopForSender(sender.id);
    const authorizedPath = await mediaService.authorizeInput(filePath);
    const ownerWindow = BrowserWindow.fromWebContents(sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error('照片流窗口已经关闭');
    const runConfig = pluginService.resolveRunConfig(COMPONENT_ID, ['--parent-hwnd', nativeWindowHandleValue(ownerWindow)]);
    const id = crypto.randomUUID();
    const child = spawn(runConfig.command, runConfig.args, {
      cwd: path.dirname(runConfig.command),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = { id, sender, child, filePath: authorizedPath, stopped: false, ready: false, lastError: '', pendingScreenshots: new Map(), onSenderDestroyed: null };
    sessions.set(id, session);
    session.onSenderDestroyed = () => stop(id, sender.id);
    sender.once('destroyed', session.onSenderDestroyed);

    const decoder = new StringDecoder('utf8');
    let buffered = '';
    let settleReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => { settleReady = resolve; rejectReady = reject; });
    const startupTimer = setTimeout(() => rejectReady(new Error('高级视频解码组件启动超时')), START_TIMEOUT_MS);
    startupTimer.unref?.();

    const consumeLine = line => {
      if (!line.trim()) return;
      let value;
      try { value = JSON.parse(line); }
      catch {
        writeLog('warn', 'Advanced video decoder emitted invalid JSON', { line: line.slice(0, 500) });
        return;
      }
      if (value.type === 'screenshot-result') {
        const requestId = String(value.requestId || '');
        const pending = session.pendingScreenshots.get(requestId);
        if (!pending) return;
        session.pendingScreenshots.delete(requestId);
        clearTimeout(pending.timer);
        if (value.success) pending.resolve({ path: String(value.path || pending.path) });
        else pending.reject(new Error(String(value.error || '无法保存当前视频帧')));
        return;
      }
      if (value.type === 'ready') {
        session.ready = true;
        clearTimeout(startupTimer);
        settleReady();
      } else if (value.type === 'fatal') {
        session.lastError = String(value.error || '高级视频解码组件启动失败');
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
      emit(session, { type: 'fatal', error: session.lastError });
    });
    child.once('exit', code => {
      clearTimeout(startupTimer);
      sessions.delete(id);
      if (!session.ready) rejectReady(new Error(session.lastError || stderr.trim() || `高级视频解码组件退出（${code ?? '未知'}）`));
      else if (!session.stopped) emit(session, { type: 'fatal', error: session.lastError || stderr.trim() || '高级视频解码组件意外退出' });
      writeLog(code === 0 || session.stopped ? 'info' : 'warn', 'Advanced video decoder exited', { sessionId: id, code, error: stderr.trim() });
    });

    try {
      await readyPromise;
      sendCommand(session, { command: 'set-keyboard-mode', value: arrowKeyAction === 'navigate' ? 'navigate' : 'seek' });
      if (!sendCommand(session, { command: 'open', path: authorizedPath })) throw new Error('无法向高级视频解码组件发送文件');
      writeLog('info', 'Advanced video decoder started', { sessionId: id, filePath: authorizedPath });
      return { sessionId: id };
    } catch (error) {
      stop(id, sender.id);
      throw error;
    }
  };

  const setBounds = (event, sessionId, bounds = {}) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.sender.id !== event.sender.id) return;
    const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
    const width = Math.max(0, Math.min(32768, number(bounds.width)));
    const height = Math.max(0, Math.min(32768, number(bounds.height)));
    sendCommand(session, {
      command: 'set-bounds',
      x: Math.max(-32768, Math.min(32768, number(bounds.x))),
      y: Math.max(-32768, Math.min(32768, number(bounds.y))),
      width,
      height,
      visible: Boolean(bounds.visible) && width > 1 && height > 1,
    });
  };

  const control = (event, sessionId, request = {}) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.sender.id !== event.sender.id) return;
    const allowed = new Set(['play', 'pause', 'seek', 'volume', 'mute', 'speed', 'stop']);
    const command = String(request.action || '');
    if (!allowed.has(command)) return;
    sendCommand(session, { command, value: request.value });
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingScreenshots.delete(requestId);
        reject(new Error('保存当前视频帧超时'));
      }, SCREENSHOT_TIMEOUT_MS);
      timer.unref?.();
      session.pendingScreenshots.set(requestId, { resolve, reject, timer, path: targetPath });
      if (!sendCommand(session, { command: 'screenshot', requestId, path: targetPath })) {
        clearTimeout(timer);
        session.pendingScreenshots.delete(requestId);
        reject(new Error('无法向视频解码组件发送截图命令'));
      }
    });
  };

  const dispose = () => {
    for (const session of [...sessions.values()]) stop(session.id);
  };

  return { start, setBounds, control, screenshot, stop, dispose, sessions };
};

module.exports = { COMPONENT_ID, createAdvancedVideoService, nativeWindowHandleValue };
