const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const isUncPath = value => /^\\\\[^\\]+\\[^\\]+/.test(String(value || '').trim());
const uncShareRoot = value => {
  const match = String(value || '').trim().match(/^(\\\\[^\\]+\\[^\\]+)/);
  return match?.[1] || '';
};

const createCredentialService = ({ writeLog }) => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'windows-credential.ps1');
  const invokeWindowsCredential = payload => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('当前系统暂不支持 NAS 凭据管理'));
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || 'Windows 凭据管理器操作失败'));
      try { resolve(JSON.parse(stdout.trim())); }
      catch (error) { reject(new Error(`Windows 凭据管理器返回了无效结果：${error.message}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });

  const credentialRefFor = remotePath => `PhotoFlow/NAS/${crypto.createHash('sha256').update(uncShareRoot(remotePath).toLocaleLowerCase()).digest('hex').slice(0, 24)}`;
  const saveNasCredential = async ({ remotePath, username, password }) => {
    const share = uncShareRoot(remotePath);
    if (!share) throw new Error('请输入有效的 NAS 共享路径，例如 \\\\studio-nas\\backup');
    if (!String(username || '').trim()) throw new Error('请输入 NAS 用户名');
    const target = credentialRefFor(share);
    await invokeWindowsCredential({ operation: 'write', target, username: String(username).trim(), password: String(password || '') });
    writeLog?.('info', 'NAS credential saved in Windows Credential Manager', { target, share });
    return { credentialRef: target, username: String(username).trim() };
  };
  const connectNas = async (remotePath, credentialRef) => {
    const share = uncShareRoot(remotePath);
    if (!share) return { connected: true };
    if (!credentialRef) throw new Error('NAS 尚未保存登录凭据');
    return invokeWindowsCredential({ operation: 'connect', target: credentialRef, remotePath: share });
  };
  const readNasCredential = async credentialRef => {
    if (!String(credentialRef || '').startsWith('PhotoFlow/NAS/')) return null;
    const result = await invokeWindowsCredential({ operation: 'inspect', target: credentialRef });
    return { username: result.username || '' };
  };
  const deleteNasCredential = async credentialRef => {
    if (!String(credentialRef || '').startsWith('PhotoFlow/NAS/')) return;
    await invokeWindowsCredential({ operation: 'delete', target: credentialRef });
  };

  return { isUncPath, uncShareRoot, saveNasCredential, connectNas, readNasCredential, deleteNasCredential };
};

module.exports = { createCredentialService, isUncPath, uncShareRoot };
