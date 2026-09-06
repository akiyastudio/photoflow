const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const electronExecutable = require('electron');
const forbidden = /database is locked|Thumbnail database request timed out|Thumbnail generation failed|is not defined|Application quit coordination failed|No handler registered for .toast-view:update.|Process supervisor is stopping|Domain health changed[^\r\n]*"state":"(?:degraded|unavailable)"|uncaught main-process exception|unhandled main-process promise rejection|-1073741515|GPU process (?:exited|crashed)/i;

const readApplicationLogs = async userData => {
  const entries = await fs.promises.readdir(path.join(userData, 'logs'), { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.log'))
    .map(entry => fs.promises.readFile(path.join(userData, 'logs', entry.name), 'utf8')))).join('\n');
};

const isProcessAlive = pid => {
  if (!pid) return false;
  try {
    const output = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return !/^INFO:/i.test(output.trim()) && output.includes(`"${pid}"`);
  } catch { return false; }
};

const launchElectron = ({ userData, sessionData, mediaPath }) => new Promise((resolve, reject) => {
  const child = spawn(electronExecutable, ['--disable-gpu', repositoryRoot], {
    cwd: repositoryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PHOTOFLOW_SMOKE_TEST: '1', PHOTOFLOW_USER_DATA_DIR: userData,
      PHOTOFLOW_SMOKE_IDLE_COMPONENT_ID: 'video-tools', PHOTOFLOW_SMOKE_QUIT_UI: '1', PHOTOFLOW_SMOKE_QUIT_QUEUED_SCANS: '30',
      PHOTOFLOW_SMOKE_SESSION_DATA_DIR: sessionData, PHOTOFLOW_SMOKE_SETUP_PROJECTS: '0', PHOTOFLOW_SMOKE_MEDIA_PATH: mediaPath,
      PYTHONDONTWRITEBYTECODE: '1' },
  });
  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => { child.kill(); reject(new Error(`Electron smoke timed out\n${stdout}\n${stderr}`)); }, 120_000);
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
    try { resolve({ evidence: JSON.parse(line.slice('PHOTOFLOW_SMOKE_RESULT='.length)), output, exitedAt: Date.now() }); }
    catch (error) { reject(new Error(`Invalid Electron smoke evidence\n${output}`, { cause: error })); }
  });
});

const assertLifecycle = (label, lifecycle, { userData, sessionData }) => {
  assert.equal(lifecycle.evidence.rendererLoaded, true, `${label} renderer`);
  assert.equal(lifecycle.evidence.preloadApi, true, `${label} preload`);
  assert.equal(lifecycle.evidence.backgroundTaskSnapshot, true, `${label} task snapshot`);
  assert.equal(lifecycle.evidence.quitUiVerified, true, `${label} styled quit dialog`);
  assert.equal(lifecycle.evidence.idleComponentReady, true, `${label} idle plugin service is running without a task`);
  assert(lifecycle.evidence.managedProcesses.some(process => process.owner?.componentId === 'video-tools' && process.pid), `${label} idle plugin must still be live when quit begins`);
  assert.equal(lifecycle.evidence.projectFilesReadable, true, `${label} project contents and files`);
  assert.equal(lifecycle.evidence.versionProgressReadable, true, `${label} version progress`);
  assert(lifecycle.evidence.managedProcesses.every(process => !process.pid || Number(process.targetPid) > 0), `${label} managed processes must use Windows Job ownership`);
  assert.equal(lifecycle.evidence.workspaceProjectCount, 40, `${label} fixture projects`);
  assert.equal(lifecycle.evidence.automaticMediaTaskCount, 0, `${label} active automatic media tasks`);
  assert.equal(lifecycle.evidence.automaticMediaFailedCount, 0, `${label} failed automatic media tasks`);
  assert.equal(lifecycle.evidence.thumbnailReady, true, `${label} thumbnail: ${lifecycle.evidence.thumbnailError || 'unknown error'}`);
  assert.equal(lifecycle.evidence.startupRecovery, 'completed', `${label} recovery`);
  assert.equal(path.resolve(lifecycle.evidence.userDataPath), path.resolve(userData));
  assert.equal(path.resolve(lifecycle.evidence.sessionDataPath), path.resolve(sessionData));
  assert.equal(path.resolve(lifecycle.evidence.rendererFile), path.resolve(repositoryRoot, 'artifacts', 'web', 'index.html'));
};

const run = async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-electron-smoke-'));
  const userData = path.join(root, 'user-data');
  const sessionDataOne = path.join(root, 'session-data-one');
  const sessionDataTwo = path.join(root, 'session-data-two');
  const workspace = path.join(root, 'workspace');
  const cache = path.join(root, 'cache');
  await Promise.all([userData, sessionDataOne, sessionDataTwo, workspace, cache].map(directory => fs.promises.mkdir(directory, { recursive: true })));
  const workspaceId = 'a'.repeat(24);
  await fs.promises.writeFile(path.join(workspace, '.photoflow-workspace-id'), `${workspaceId}\n`);
  await fs.promises.writeFile(path.join(userData, 'photoflow_config.json'), JSON.stringify({
    workspacePath: workspace, mediaCache: { directory: cache, maxSizeGB: 1 }, backup: { enabled: false, targetPath: '' },
  }));
  try {
    const oldMediaTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (let index = 0; index < 40; index += 1) {
      const projectRoot = path.join(workspace, `启动验收 ${String(index + 1).padStart(2, '0')}`);
      await fs.promises.mkdir(projectRoot);
      const mediaPath = path.join(projectRoot, '旧媒体.jpg');
      await fs.promises.writeFile(mediaPath, `smoke-${index}`);
      await fs.promises.utimes(mediaPath, oldMediaTime, oldMediaTime);
    }
    const smokeMediaPath = path.join(workspace, '启动验收 01', 'smoke.png');
    await fs.promises.writeFile(smokeMediaPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const databaseDirectory = path.join(userData, 'workspace-data');
    await fs.promises.mkdir(databaseDirectory, { recursive: true });
    execFileSync(path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe'), [path.join(repositoryRoot, 'python', 'workspace_db.py'),
      'catalog_sync', '--root', workspace, '--database', path.join(databaseDirectory, `${workspaceId}.sqlite3`), '--payload', '{}'],
    { encoding: 'utf8', windowsHide: true });

    const first = await launchElectron({ userData, sessionData: sessionDataOne, mediaPath: smokeMediaPath });
    const second = await launchElectron({ userData, sessionData: sessionDataTwo, mediaPath: smokeMediaPath });
    assertLifecycle('first', first, { userData, sessionData: sessionDataOne });
    assertLifecycle('second', second, { userData, sessionData: sessionDataTwo });
    const applicationLogs = await readApplicationLogs(userData);
    const timingRows = applicationLogs.split(/\r?\n/).filter(line => line.includes('Application quit timing')).map(line => JSON.parse(line.slice(line.indexOf('{'))));
    assert.equal(timingRows.length, 2);
    for (const timing of timingRows) { assert(timing.windowHiddenMs < 200, JSON.stringify(timing)); assert(timing.completedMs < 1500, JSON.stringify(timing)); }
    const processExitMs = [first, second].map((lifecycle, index) => lifecycle.exitedAt - timingRows[index].startedAt);
    assert(processExitMs.every(duration => duration < 1500), JSON.stringify(processExitMs));
    const tasksAfterQuit = JSON.parse(await fs.promises.readFile(path.join(userData, 'background-tasks.json'), 'utf8')).tasks;
    assert.equal(tasksAfterQuit.filter(task => task.type === 'version-media-rescan' && task.state === 'failed').length, 0);
    console.log('Quit timing evidence: ' + JSON.stringify({ stages: timingRows, processExitMs }));
    assert.equal(forbidden.test(`${first.output}\n${second.output}\n${applicationLogs}`), false, 'both lifecycles must have no forbidden logs');
    const childPids = [...new Set([...first.evidence.managedProcesses, ...second.evidence.managedProcesses].flatMap(process => [process.pid, process.targetPid]).filter(Boolean))];
    assert.equal(childPids.some(isProcessAlive), false, 'all supervised Python children must exit with Electron');
    console.log(`Electron smoke evidence: lifecycles=2 projects=40 automatic_media_tasks=0 failed_automatic_media_tasks=0 recovery=completed isolated_paths=verified child_processes_exited=${childPids.length}`);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
