const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const isUncPath = value => /^\\\\[^\\]+\\[^\\]+/.test(String(value || '').trim());
const uncShareRoot = value => {
  const match = String(value || '').trim().match(/^(\\\\[^\\]+\\[^\\]+)/);
  return match?.[1] || '';
};
const normalizedShare = value => uncShareRoot(value).replace(/[\\/]+$/, '').toLowerCase();
const MAX_OUTPUT_BYTES = 64 * 1024;
const CREDENTIAL_TIMEOUT_MS = 30 * 1000;

const createCredentialService = ({ writeLog }) => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'windows-credential.ps1');
  const invokeWindowsCredential = (payload, { signal, timeoutMs = CREDENTIAL_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('当前系统暂不支持 NAS 凭据管理'));
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const terminate = error => {
      if (settled) return;
      child.kill();
      const killTimer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); }, 2000);
      killTimer.unref?.();
      settle(reject, error);
    };
    const onAbort = () => terminate(Object.assign(new Error('凭据操作已取消'), { code: 'TASK_CANCELLED' }));
    const timer = setTimeout(() => terminate(Object.assign(new Error('Windows 凭据管理器操作超时'), { code: 'CREDENTIAL_TIMEOUT' })), timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const append = (kind, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) { terminate(Object.assign(new Error('Windows 凭据管理器输出过大'), { code: 'CREDENTIAL_OUTPUT_LIMIT' })); return; }
      if (kind === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.on('error', error => settle(reject, error));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { settle(reject, new Error(stderr.trim() || 'Windows 凭据管理器操作失败')); return; }
      try { settle(resolve, JSON.parse(stdout.trim())); }
      catch (error) { settle(reject, new Error(`Windows 凭据管理器返回了无效结果：${error.message}`)); }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    child.stdin.on('error', error => settle(reject, error));
    child.stdin.end(JSON.stringify(payload), error => { if (error) settle(reject, error); });
  });

  const credentialRefFor = remotePath => `PhotoFlow/NAS/${crypto.createHash('sha256').update(normalizedShare(remotePath)).digest('hex').slice(0, 24)}`;
  const saveNasCredential = async ({ remotePath, username, password, signal } = {}) => {
    const share = uncShareRoot(remotePath);
    if (!share) throw new Error('请输入有效的 NAS 共享路径，例如 \\\\studio-nas\\backup');
    if (!String(username || '').trim()) throw new Error('请输入 NAS 用户名');
    const target = credentialRefFor(share);
    await invokeWindowsCredential({ operation: 'write', target, username: String(username).trim(), password: String(password || '') }, { signal });
    writeLog?.('info', 'NAS credential saved in Windows Credential Manager', { target, share });
    return { credentialRef: target, username: String(username).trim() };
  };
  const connectNas = async (remotePath, credentialRef, options = {}) => {
    const share = uncShareRoot(remotePath);
    if (!share) return { connected: true };
    if (!credentialRef) throw new Error('NAS 尚未保存登录凭据');
    if (credentialRef !== credentialRefFor(share)) throw new Error('NAS 凭据与当前共享路径不匹配');
    return invokeWindowsCredential({ operation: 'connect', target: credentialRef, remotePath: share }, options);
  };
  const readNasCredential = async (credentialRef, options = {}) => {
    if (!String(credentialRef || '').startsWith('PhotoFlow/NAS/')) return null;
    const result = await invokeWindowsCredential({ operation: 'inspect', target: credentialRef }, options);
    return { username: result.username || '' };
  };
  const deleteNasCredential = async (credentialRef, options = {}) => {
    if (!String(credentialRef || '').startsWith('PhotoFlow/NAS/')) return;
    await invokeWindowsCredential({ operation: 'delete', target: credentialRef }, options);
  };

  return { isUncPath, uncShareRoot, saveNasCredential, connectNas, readNasCredential, deleteNasCredential };
};

module.exports = { createCredentialService, isUncPath, uncShareRoot, normalizedShare };
