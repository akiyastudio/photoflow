const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const run = (command, args) => { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' }); if (result.error) throw result.error; if ((result.status ?? 1) !== 0) throw new Error(`${command} failed with code ${result.status}`); };
const environmentPath = development => path.join(root, development ? '.venv' : '.venv-release');
const interpreterPath = development => path.join(environmentPath(development), 'Scripts', 'python.exe');
function expectedLockedDistributions(lockText) {
  const values = new Map();
  for (const raw of lockText.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)==([^\s\\]+)(?:\s|\\|$)/.exec(raw.trim());
    if (match) values.set(match[1].toLowerCase().replaceAll('_','-'), match[2]);
  }
  if (!values.size) throw new Error('Formal Python lock contains no exact distributions.');
  return values;
}
function verifyLockedEnvironment(python, lockText) {
  const expected = expectedLockedDistributions(lockText);
  const result = spawnSync(python, ['-c', 'import importlib.metadata,json; print(json.dumps({d.metadata["Name"].lower().replace("_","-"):d.version for d in importlib.metadata.distributions()}))'], { cwd: root, encoding: 'utf8' });
  if ((result.status ?? 1) !== 0) throw new Error(result.stderr || 'Unable to inventory release Python environment.');
  const actual = new Map(Object.entries(JSON.parse(result.stdout.trim()))); const allowedBase = new Set(['pip','setuptools','wheel']);
  for (const [name, version] of expected) if (actual.get(name) !== version) throw new Error(`Release Python distribution mismatch: ${name}==${actual.get(name) || 'missing'} expected ${version}`);
  for (const name of actual.keys()) if (!expected.has(name) && !allowedBase.has(name)) throw new Error(`Unexpected release Python distribution: ${name}`);
}
function main(values = process.argv.slice(2)) {
  const development = values.length === 1 && values[0] === '--dev';
  if (values.length && !development) throw new Error('Unknown setup-python argument.');
  if (process.platform !== 'win32') throw new Error('Team-retouch release runtime is Windows Python 3.12 x64 only.');
  const venv = environmentPath(development); const python = interpreterPath(development);
  const hashedLock = path.join(root, 'requirements-build.lock');
  if (!development && !fs.existsSync(hashedLock)) throw new Error('Formal Python setup requires requirements-build.lock with hashes.');
  if (!fs.existsSync(python)) run('py', ['-3.12-64', '-m', 'venv', venv]);
  run(python, ['-c', 'import platform,sys; assert sys.version_info[:2]==(3,12) and platform.architecture()[0]=="64bit", "Python 3.12 x64 is required"']);
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', ...(development ? ['-r','requirements-build.txt'] : ['--require-hashes','--no-deps','-r',hashedLock])]);
  if (!development) verifyLockedEnvironment(python, fs.readFileSync(hashedLock, 'utf8'));
  run(python, ['-c', 'import cv2, onnxruntime, PIL, numpy; print("Plugin Python 3.12 x64 environment ready")']);
}
if (require.main === module) main();
module.exports = { environmentPath, interpreterPath, expectedLockedDistributions, verifyLockedEnvironment, main };
