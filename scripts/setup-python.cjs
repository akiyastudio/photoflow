const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const venvRoot = path.join(root, '.venv');
const venvPython = process.platform === 'win32'
  ? path.join(venvRoot, 'Scripts', 'python.exe')
  : path.join(venvRoot, 'bin', 'python');
const systemPython = process.platform === 'win32' ? 'python' : 'python3';

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}`);
};

const ensurePythonEnvironment = () => {
  if (!fs.existsSync(venvPython)) run(systemPython, ['-m', 'venv', venvRoot]);
  run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt']);
  run(venvPython, [path.join('scripts', 'verify-python-environment.py')]);
  return venvPython;
};

if (require.main === module) {
  try {
    ensurePythonEnvironment();
    console.log('PhotoFlow Python environment is ready.');
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = { ensurePythonEnvironment, root, venvPython };
