const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const electronExecutable = require('electron');
const forbidden = /database is locked|Thumbnail database request timed out|uncaught main-process exception|unhandled main-process promise rejection|-1073741515|GPU process (?:exited|crashed)/i;

const readApplicationLogs = async userData => {
  const logDirectory = path.join(userData, 'logs');
  const entries = await fs.promises.readdir(logDirectory, { withFileTypes: true }).catch(() => []);
  const logs = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.log'))
    .map(entry => fs.promises.readFile(path.join(logDirectory, entry.name), 'utf8')));
  return logs.join('\n');
};

const isProcessAlive = pid => {
  if (!pid) return false;
  try {
    const output = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return !/^INFO:/i.test(output.trim()) && output.includes(`"${pid}"`);
  } catch { return false; }
};

const run = async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-electron-smoke-'));
  const userData = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  const cache = path.join(root, 'cache');
  await Promise.all([userData, workspace, cache].map(directory => fs.promises.mkdir(directory, { recursive: true })));
  await fs.promises.writeFile(path.join(workspace, '.photoflow-workspace-id'), 'smoke-workspace\n');
  await fs.promises.writeFile(path.join(userData, 'photoflow_config.json'), JSON.stringify({
    workspacePath: workspace,
    mediaCache: { directory: cache, maxSizeGB: 1 },
    backup: { enabled: false, targetPath: '' },
  }));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electronExecutable, ['--disable-gpu', repositoryRoot], {
        cwd: repositoryRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PHOTOFLOW_SMOKE_TEST: '1',
          PHOTOFLOW_USER_DATA_DIR: userData,
          PYTHONDONTWRITEBYTECODE: '1',
        },
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Electron smoke timed out\n${stdout}\n${stderr}`));
      }, 120_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => {
        clearTimeout(timeout);
        const output = `${stdout}\n${stderr}`;
        if (code !== 0) { reject(new Error(`Electron exited ${code}\n${output}`)); return; }
        const line = stdout.split(/\r?\n/).find(value => value.startsWith('PHOTOFLOW_SMOKE_RESULT='));
        if (!line) { reject(new Error(`Electron did not report smoke evidence\n${output}`)); return; }
        try { resolve({ evidence: JSON.parse(line.slice('PHOTOFLOW_SMOKE_RESULT='.length)), output }); }
        catch (error) { reject(new Error(`Invalid Electron smoke evidence\n${output}`, { cause: error })); }
      });
    });
    assert.equal(result.evidence.rendererLoaded, true);
    assert.equal(result.evidence.preloadApi, true);
    assert.equal(result.evidence.backgroundTaskSnapshot, true);
    assert.equal(result.evidence.startupRecovery, 'completed');
    assert.equal(path.resolve(result.evidence.userDataPath), path.resolve(userData));
    assert.equal(path.resolve(result.evidence.rendererFile), path.resolve(repositoryRoot, 'artifacts', 'web', 'index.html'));
    const applicationLogs = await readApplicationLogs(userData);
    assert.equal(forbidden.test(`${result.output}\n${applicationLogs}`), false, 'smoke output and application logs must not contain lock, timeout, GPU-process, or uncaught errors');
    const childPids = result.evidence.managedProcesses.map(process => process.pid).filter(Boolean);
    assert.equal(childPids.some(isProcessAlive), false, 'all supervised Python children must exit with Electron');
    console.log(`Electron smoke evidence: renderer=loaded preload=available tasks=read recovery=${result.evidence.startupRecovery} child_processes_exited=${childPids.length}`);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
