const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const venvRoot = path.join(root, '.venv');
const venvPython = process.platform === 'win32' ? path.join(venvRoot, 'Scripts', 'python.exe') : path.join(venvRoot, 'bin', 'python');
const requirementsPath = path.join(root, 'requirements.txt');
const stampPath = path.join(venvRoot, '.photoflow-requirements.sha256');
const requirementsFingerprint = crypto.createHash('sha256').update(`${process.platform}\0${process.arch}\0`).update(fs.readFileSync(requirementsPath)).digest('hex');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
};
if (!fs.existsSync(venvPython)) {
  if (process.env.PYTHON) run(process.env.PYTHON, ['-m', 'venv', venvRoot]);
  else if (process.platform === 'win32') run('py', ['-3.12', '-m', 'venv', venvRoot]);
  else run('python3', ['-m', 'venv', venvRoot]);
}
const imports = spawnSync(venvPython, ['-c', 'import PyInstaller, send2trash'], { cwd: root, stdio: 'ignore', windowsHide: true });
const currentFingerprint = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
if (imports.status !== 0 || currentFingerprint !== requirementsFingerprint) {
  run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt']);
  fs.writeFileSync(stampPath, `${requirementsFingerprint}\n`, 'utf8');
}
console.log(`Video tools private Python environment ready: ${venvPython}`);
