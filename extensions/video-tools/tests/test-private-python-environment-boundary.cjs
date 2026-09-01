const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertPrivateVenvRoot, pathsReferToSameLocation } = require('../scripts/private-venv-boundary.cjs');
const { setupPythonEnvironment } = require('../scripts/setup-python.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-tools-private-venv-'));
try {
  const componentRoot = path.join(temporaryRoot, 'component');
  const outsideRoot = path.join(temporaryRoot, 'root-venv');
  fs.mkdirSync(componentRoot);
  fs.mkdirSync(outsideRoot);
  fs.writeFileSync(path.join(componentRoot, 'requirements.txt'), 'PyInstaller==0\nsend2trash==0\n');
  const canaryPath = path.join(outsideRoot, 'canary.txt');
  const outsideStampPath = path.join(outsideRoot, '.photoflow-requirements.sha256');
  fs.writeFileSync(canaryPath, 'root-canary\n');
  fs.writeFileSync(outsideStampPath, 'root-stamp\n');

  const linkedVenv = path.join(componentRoot, '.venv');
  fs.symlinkSync(outsideRoot, linkedVenv, process.platform === 'win32' ? 'junction' : 'dir');
  let spawnCount = 0;
  assert.throws(
    () => setupPythonEnvironment({ root: componentRoot, spawnSyncImpl: () => { spawnCount += 1; return { status: 0 }; }, log: () => {} }),
    /Refusing (linked|redirected) private Python environment root/,
  );
  assert.equal(spawnCount, 0, 'a redirected environment must not execute its Python or pip');
  assert.equal(fs.readFileSync(canaryPath, 'utf8'), 'root-canary\n');
  assert.equal(fs.readFileSync(outsideStampPath, 'utf8'), 'root-stamp\n');

  fs.unlinkSync(linkedVenv);
  const interpreterDirectory = process.platform === 'win32' ? path.join(linkedVenv, 'Scripts') : path.join(linkedVenv, 'bin');
  const interpreterPath = process.platform === 'win32' ? path.join(interpreterDirectory, 'python.exe') : path.join(interpreterDirectory, 'python');
  fs.mkdirSync(interpreterDirectory, { recursive: true });
  if (process.platform === 'win32') fs.writeFileSync(interpreterPath, 'fixture');
  else fs.symlinkSync('/usr/bin/env', interpreterPath);

  const calls = [];
  const first = setupPythonEnvironment({ root: componentRoot, spawnSyncImpl: (command, args) => { calls.push({ command, args }); return { status: 0 }; }, log: () => {} });
  assert.equal(calls.length, 2, 'a fresh ordinary private directory checks imports and installs requirements once');
  assert.equal(calls[0].command, interpreterPath, 'an interpreter symlink inside an ordinary private venv remains supported');
  assert.equal(fs.readFileSync(first.stampPath, 'utf8'), `${first.requirementsFingerprint}\n`);

  calls.length = 0;
  setupPythonEnvironment({ root: componentRoot, spawnSyncImpl: (command, args) => { calls.push({ command, args }); return { status: 0 }; }, log: () => {} });
  assert.equal(calls.length, 1, 'an unchanged environment is idempotent and does not reinstall');
  assert.deepEqual(calls[0].args, ['-c', 'import PyInstaller, send2trash']);

  assert(pathsReferToSameLocation('C:\\Repo\\component\\.venv', 'c:\\repo\\component\\.venv\\', 'win32'));
  assert(!pathsReferToSameLocation('C:\\root\\.venv', 'C:\\repo\\component\\.venv', 'win32'));
  assert(pathsReferToSameLocation('/repo/component/.venv', '/repo/component/.venv/', 'linux'));
  assert(!pathsReferToSameLocation('/root/.venv', '/repo/component/.venv', 'linux'));
  assert.throws(
    () => assertPrivateVenvRoot('/repo/component/.venv', {
      platform: 'linux',
      fsImpl: {
        lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
        realpathSync: Object.assign(() => '/root/.venv', { native: () => '/root/.venv' }),
      },
    }),
    /Refusing redirected private Python environment root/,
    'a non-link reparse-style directory whose real path escapes must also fail closed',
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('video tools private Python environment boundary tests passed');
