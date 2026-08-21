const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
let recycleProcessSequence = 0;

const probeManyIndividually = async (values, probe) => {
  const items = [];
  for (const pidl of values) {
    try { items.push({ pidl, ...await probe(pidl) }); }
    catch (error) { items.push({ success: false, exists: false, pidl, error: error.message || String(error) }); }
  }
  return { success: true, items };
};

const runJson = (command, args, timeoutMs = 120000, stdin = '', processSupervisor = null) => new Promise((resolve, reject) => {
  const child = processSupervisor
    ? processSupervisor.launch({
      id: `csharp:recycle-bin:${++recycleProcessSequence}`,
      kind: 'csharp-helper', command, args, options: { stdio: ['pipe', 'pipe', 'pipe'] }, ephemeral: true,
    }).child
    : spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin);
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

const createRecycleBinService = ({ app, shell, projectRoot, processSupervisor = null }) => {
  const executable = () => app.isPackaged
    ? path.join(process.resourcesPath, 'recycle-bin-service.exe')
    : path.join(projectRoot, 'electron', 'bin', 'recycle-bin-service.exe');

  const nativeAvailable = () => process.platform === 'win32' && fs.existsSync(executable());

  const trash = async filePath => {
    const resolved = path.resolve(filePath);
    if (nativeAvailable()) {
      return runJson(executable(), ['trash', '--path', resolved], 120000, '', processSupervisor);
    }
    if (process.platform === 'win32') {
      const error = new Error('Windows 回收站服务未安装，已取消删除以避免无法撤销');
      error.code = 'RECYCLE_SERVICE_MISSING';
      throw error;
    }
    await shell.trashItem(resolved);
    return { success: true, originalPath: resolved, recyclePidl: '', preciseRestore: false };
  };

  const trashMany = async filePaths => {
    const resolvedPaths = Array.from(new Set((Array.isArray(filePaths) ? filePaths : []).map(filePath => path.resolve(filePath))));
    if (!resolvedPaths.length) return { success: true, items: [] };
    if (nativeAvailable()) {
      const timeoutMs = Math.min(15 * 60 * 1000, 120000 + resolvedPaths.length * 2000);
      return runJson(executable(), ['trash-many'], timeoutMs, JSON.stringify(resolvedPaths), processSupervisor);
    }
    if (process.platform === 'win32') {
      const error = new Error('Windows 回收站服务未安装，已取消删除以避免无法撤销');
      error.code = 'RECYCLE_SERVICE_MISSING';
      throw error;
    }
    const items = [];
    for (const resolved of resolvedPaths) {
      await shell.trashItem(resolved);
      items.push({ success: true, originalPath: resolved, recyclePidl: '', preciseRestore: false, permanent: false });
    }
    return { success: true, items };
  };

  const restore = async ({ recyclePidl, originalPath }) => {
    if (!recyclePidl || !nativeAvailable()) {
      const error = new Error('当前系统无法从软件内精确恢复，请打开系统回收站手动还原');
      error.code = 'MANUAL_RESTORE_REQUIRED';
      throw error;
    }
    return runJson(executable(), ['restore', '--pidl', recyclePidl, '--target', path.resolve(originalPath)], 120000, '', processSupervisor);
  };

  const probe = async recyclePidl => {
    if (!recyclePidl || !nativeAvailable()) return { success: true, exists: false };
    return runJson(executable(), ['probe', '--pidl', recyclePidl], 15000, '', processSupervisor);
  };

  const probeMany = async recyclePidls => {
    const values = Array.from(new Set((Array.isArray(recyclePidls) ? recyclePidls : []).filter(Boolean).map(String)));
    if (!values.length || !nativeAvailable()) return { success: true, items: [] };
    try {
      return await runJson(executable(), ['probe-many'], Math.min(120000, 15000 + values.length * 250), JSON.stringify(values), processSupervisor);
    } catch {
      return probeManyIndividually(values, probe);
    }
  };

  return { trash, trashMany, restore, probe, probeMany, nativeAvailable };
};

module.exports = { createRecycleBinService, probeManyIndividually };
