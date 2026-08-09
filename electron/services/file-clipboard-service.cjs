const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const runJson = (command, args, stdin = '', timeoutMs = 12000) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.on('error', error => finish(error));
  child.on('close', code => {
    const line = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).pop();
    let payload;
    try { payload = line ? JSON.parse(line) : null; } catch { /* handled below */ }
    if (!payload) return finish(new Error(stderr.trim() || `文件剪贴板服务未返回有效 JSON（代码 ${code}）`));
    if (!payload.success) {
      const error = Object.assign(new Error(payload.error || stderr.trim() || '文件剪贴板服务失败'), { code: payload.code || 'FILE_CLIPBOARD_FAILED' });
      return finish(error);
    }
    finish(null, payload);
  });
  const timer = setTimeout(() => {
    if (!child.killed) child.kill();
    finish(Object.assign(new Error('文件剪贴板服务响应超时'), { code: 'FILE_CLIPBOARD_TIMEOUT' }));
  }, timeoutMs);
});

const createFileClipboardService = ({ app, projectRoot }) => {
  const executable = () => app.isPackaged
    ? path.join(process.resourcesPath, 'file-clipboard-service.exe')
    : path.join(projectRoot, 'electron', 'bin', 'file-clipboard-service.exe');
  const ensureAvailable = () => {
    if (process.platform !== 'win32') return false;
    if (fs.existsSync(executable())) return true;
    const error = new Error('Windows 文件剪贴板服务缺失，请重新安装或运行构建脚本');
    error.code = 'FILE_CLIPBOARD_SERVICE_MISSING';
    throw error;
  };
  let mutationQueue = Promise.resolve();
  const queueMutation = operation => {
    const queued = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = queued.catch(() => undefined);
    return queued;
  };
  const write = async (sources, operation) => {
    if (!ensureAvailable()) return { success: true, written: false, sources: [...sources], operation, sequence: 0 };
    return queueMutation(() => runJson(executable(), ['write'], JSON.stringify({ sources, operation })));
  };
  const read = async () => {
    if (!ensureAvailable()) return null;
    await mutationQueue.catch(() => undefined);
    return runJson(executable(), ['read']);
  };
  const clearIfCurrent = async snapshot => {
    if (!ensureAvailable()) return { success: true, cleared: false, sources: [], operation: 'copy', sequence: 0 };
    return queueMutation(() => runJson(executable(), ['clear-if-current'], JSON.stringify({ sequence: snapshot.sequence, sources: snapshot.sources })));
  };
  return { write, read, clearIfCurrent, executable, nativeAvailable: () => process.platform === 'win32' && fs.existsSync(executable()) };
};

module.exports = { createFileClipboardService };
