const HANDLE = /^[1-9][0-9]{0,19}$/;

const nativeHandleValue = window => {
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) throw new Error('无法读取照片流窗口句柄');
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
};

const createNativeVideoSurfaceService = ({ app, path, processSupervisor = null, spawn, writeLog, startupTimeoutMs = 5000 }) => {
  const command = app.isPackaged
    ? path.join(process.resourcesPath, 'video-surface-host.exe')
    : path.join(__dirname, '..', 'bin', 'video-surface-host.exe');
  const attach = async ({ ownerWindow, componentProcess, surfaceHandle, sessionId, onLost = () => undefined }) => {
    const childHandle = String(surfaceHandle || ''); const expectedPid = Number(componentProcess?.pid);
    if (!HANDLE.test(childHandle) || !Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !ownerWindow || ownerWindow.isDestroyed()) throw new Error('原生视频表面声明无效');
    const args = ['--parent-hwnd', nativeHandleValue(ownerWindow), '--child-hwnd', childHandle, '--expected-pid', String(expectedPid), '--session-id', sessionId];
    const managed = processSupervisor?.launch({ id: `video-surface:${sessionId}`, kind: 'native-helper', command, args, options: { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, health: { startupTimeoutMs }, ephemeral: true });
    const child = managed?.child || spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let closed = false; let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('原生视频表面附着超时')), startupTimeoutMs); timer.unref?.();
      let buffered = '';
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(new Error(stderr.trim() || `原生视频表面宿主退出（${code ?? '未知'}）`)));
      child.stdout.on('data', chunk => {
        buffered += chunk.toString('utf8');
        const line = buffered.split(/\r?\n/, 1)[0];
        if (!line) return;
        try {
          const value = JSON.parse(line);
          if (value.type !== 'ready' || value.sessionId !== sessionId) throw new Error('原生视频表面宿主握手无效');
          clearTimeout(timer); managed?.markHealthy({ protocol: 'native-video-surface-v1' }); resolve();
        } catch (error) { fail(error); }
      });
    }).catch(error => { try { child.kill(); } catch { /* already exited */ } throw error; });
    child.once('exit', code => { if (!closed) onLost(new Error(`原生视频表面丢失（${code ?? '未知'}）`)); });
    const setBounds = bounds => {
      if (closed || !child.stdin.writable) return false;
      try { child.stdin.write(`${JSON.stringify({ command: 'bounds', ...bounds })}\n`); return true; }
      catch (error) { writeLog('warn', 'Unable to position native video surface', { sessionId, error: error.message || String(error) }); return false; }
    };
    const close = () => {
      if (closed) return; closed = true;
      try { child.stdin.end(`${JSON.stringify({ command: 'close' })}\n`); } catch { /* already exited */ }
      const timer = setTimeout(() => managed ? managed.stop('video-surface-close') : !child.killed && child.kill(), 1000); timer.unref?.();
    };
    return { setBounds, close, child, sessionId, expectedPid, surfaceHandle: childHandle };
  };
  return { attach };
};

module.exports = { createNativeVideoSurfaceService, nativeHandleValue };
