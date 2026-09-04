const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

const setupWsl = fs.readFileSync(path.join(root, 'scripts', 'setup-advanced-wsl.sh'), 'utf8');
const samDownload = setupWsl.indexOf('sam2.1_hiera_large.pt"');
const checkpointVerify = setupWsl.indexOf('sha256sum --check --strict');
const pairSelfTest = setupWsl.indexOf('pairdetr_service.py" --self-test');
const samSelfTest = setupWsl.indexOf('sam2_service.py" --self-test');
const receipt = setupWsl.indexOf('self-test-receipt.json');
assert(samDownload >= 0 && samDownload < checkpointVerify && checkpointVerify < pairSelfTest && pairSelfTest < samSelfTest && samSelfTest < receipt, 'advanced checkpoints must all download and verify before both self-tests and receipt');

const exporter = fs.readFileSync(path.join(root, 'scripts', 'create-advanced-offline-package.ps1'), 'utf8');
assert(exporter.indexOf('--self-test') >= 0 && exporter.indexOf('--self-test') < exporter.indexOf('wsl.exe --terminate'), 'both model self-tests gate VHD export');

const formalPython = spawnSync(process.execPath, [path.join(root, 'scripts', 'setup-python.cjs')], { cwd: root, encoding: 'utf8' });
assert.notEqual(formalPython.status, 0);
assert.match(`${formalPython.stdout}${formalPython.stderr}`, /requires requirements-build\.lock with hashes/);
console.log('Team-retouch release self-test ordering and formal Python lock gates passed');
