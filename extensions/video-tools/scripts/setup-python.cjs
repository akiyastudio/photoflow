const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { assertPrivateVenvRoot } = require('./private-venv-boundary.cjs');

function setupPythonEnvironment({
  root = path.resolve(__dirname, '..'),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  spawnSyncImpl = spawnSync,
  log = console.log,
} = {}) {
  const venvRoot = path.join(root, '.venv');
  const venvPython = platform === 'win32' ? path.join(venvRoot, 'Scripts', 'python.exe') : path.join(venvRoot, 'bin', 'python');
  const requirementsPath = path.join(root, 'requirements.txt');
  const stampPath = path.join(venvRoot, '.photoflow-requirements.sha256');

  // This must precede every read, process launch, or write beneath .venv.
  assertPrivateVenvRoot(venvRoot, { platform });

  const requirementsFingerprint = crypto.createHash('sha256').update(`${platform}\0${arch}\0`).update(fs.readFileSync(requirementsPath)).digest('hex');
  const run = (command, args) => {
    const result = spawnSyncImpl(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) {
      const error = new Error(`${command} exited with status ${result.status ?? 1}`);
      error.exitCode = result.status ?? 1;
      throw error;
    }
  };

  if (!fs.existsSync(venvPython)) {
    if (env.PYTHON) run(env.PYTHON, ['-m', 'venv', venvRoot]);
    else if (platform === 'win32') run('py', ['-3.12', '-m', 'venv', venvRoot]);
    else run('python3', ['-m', 'venv', venvRoot]);
    assertPrivateVenvRoot(venvRoot, { platform });
  }
  const imports = spawnSyncImpl(venvPython, ['-c', 'import PyInstaller, send2trash'], { cwd: root, stdio: 'ignore', windowsHide: true });
  if (imports.error) throw imports.error;
  const currentFingerprint = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
  if (imports.status !== 0 || currentFingerprint !== requirementsFingerprint) {
    run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt']);
    fs.writeFileSync(stampPath, `${requirementsFingerprint}\n`, 'utf8');
  }
  log(`Video tools private Python environment ready: ${venvPython}`);
  return { requirementsFingerprint, stampPath, venvPython, venvRoot };
}

if (require.main === module) {
  try {
    setupPythonEnvironment();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = error && error.exitCode ? error.exitCode : 1;
  }
}

module.exports = { setupPythonEnvironment };
