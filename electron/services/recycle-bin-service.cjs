const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const runJson = (command, args, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(value);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-2 * 1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.on('error', error => finish(error));
  child.on('close', code => {
    const lines = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    let payload;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { payload = JSON.parse(lines[index]); break; } catch { /* keep searching */ }
    }
    if (!payload) return finish(new Error(stderr.trim() || `回收站辅助程序未返回有效结果（代码 ${code}）`));
    if (!payload.success) {
      const errorCode = payload.code || (args[0] === 'trash' ? 'RECYCLE_BIN_FAILED' : undefined);
      const error = Object.assign(new Error(payload.error || '回收站操作失败'), { code: errorCode, hresult: payload.hresult });
      return finish(error);
    }
    finish(null, payload);
  });
  const timer = setTimeout(() => {
    if (!child.killed) child.kill();
    finish(new Error('回收站操作超时'));
  }, timeoutMs);
});

const createRecycleBinService = ({ app, shell, projectRoot }) => {
  const capabilityByRoot = new Map();
  const executable = () => app.isPackaged
    ? path.join(process.resourcesPath, 'recycle-bin-service.exe')
    : path.join(projectRoot, 'electron', 'bin', 'recycle-bin-service.exe');

  const nativeAvailable = () => process.platform === 'win32' && fs.existsSync(executable());

  const trash = async filePath => {
    const resolved = path.resolve(filePath);
    if (nativeAvailable()) {
      const parsed = path.parse(resolved);
      const capabilityKey = parsed.root.toLocaleLowerCase();
      let supported = capabilityByRoot.get(capabilityKey);
      if (supported === undefined) {
        const sourceStat = await fs.promises.stat(resolved);
        const checkDirectory = sourceStat.isDirectory() ? resolved : path.dirname(resolved);
        const result = await runJson(executable(), ['check', '--directory', checkDirectory]);
        supported = Boolean(result.supported);
        capabilityByRoot.set(capabilityKey, supported);
        if (!supported) {
          const error = new Error(result.reason || '该磁盘没有可用的系统回收站，已取消删除');
          error.code = 'RECYCLE_UNAVAILABLE';
          throw error;
        }
      }
      return runJson(executable(), ['trash', '--path', resolved]);
    }
    if (process.platform === 'win32') {
      const error = new Error('Windows 回收站服务未安装，已取消删除以避免无法撤销');
      error.code = 'RECYCLE_SERVICE_MISSING';
      throw error;
    }
    await shell.trashItem(resolved);
    return { success: true, originalPath: resolved, recyclePidl: '', preciseRestore: false };
  };

  const restore = async ({ recyclePidl, originalPath }) => {
    if (!recyclePidl || !nativeAvailable()) {
      const error = new Error('当前系统无法从软件内精确恢复，请打开系统回收站手动还原');
      error.code = 'MANUAL_RESTORE_REQUIRED';
      throw error;
    }
    return runJson(executable(), ['restore', '--pidl', recyclePidl, '--target', path.resolve(originalPath)]);
  };

  const probe = async recyclePidl => {
    if (!recyclePidl || !nativeAvailable()) return { success: true, exists: false };
    return runJson(executable(), ['probe', '--pidl', recyclePidl], 15000);
  };

  return { trash, restore, probe, nativeAvailable };
};

module.exports = { createRecycleBinService };
