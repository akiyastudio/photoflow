const assert = require('node:assert/strict');
const path = require('node:path');
const { advancedRuntimeFailureStatus, validateAlgorithmRuntime } = require('../service.cjs');

assert.deepEqual(
  validateAlgorithmRuntime({ command: process.execPath, argsPrefix: ['-u', __filename] }),
  { command: process.execPath, argsPrefix: ['-u', __filename] },
  'development interpreter switches are not mistaken for component entry files',
);
assert.throws(() => validateAlgorithmRuntime({ command: process.execPath, argsPrefix: ['-u', path.join(__dirname, 'missing-entry.py')] }), /开发算法入口不存在/);

const developmentDenied = advancedRuntimeFailureStatus('错误代码: Wsl/Service/E_ACCESSDENIED', { development: true });
assert.deepEqual(
  { state: developmentDenied.state, category: developmentDenied.errorCategory, source: developmentDenied.runtimeSource },
  { state: 'unavailable', category: 'wsl-access-denied', source: 'development' },
);
assert.match(developmentDenied.message, /普通终端/);

const packagedDenied = advancedRuntimeFailureStatus('Access is denied', { development: false });
assert.equal(packagedDenied.state, 'unavailable');
assert.equal(packagedDenied.runtimeSource, 'packaged');
assert.doesNotMatch(packagedDenied.message, /开发/);

const missing = advancedRuntimeFailureStatus('Wsl/Service/WSL_E_DISTRO_NOT_FOUND', { development: false });
assert.equal(missing.state, 'not-installed');
assert.equal(missing.errorCategory, 'not-installed');

const incomplete = advancedRuntimeFailureStatus('SAM 2.1 import failed', { development: false });
assert.equal(incomplete.state, 'repair-needed');
assert.equal(incomplete.errorCategory, 'runtime-incomplete');

const coldStartTimeout = advancedRuntimeFailureStatus("Command ['wsl.exe'] timed out after 12 seconds", { development: false });
assert.equal(coldStartTimeout.state, 'unavailable');
assert.equal(coldStartTimeout.errorCategory, 'wsl-start-timeout');
assert.match(coldStartTimeout.message, /稍候/);

console.log('Team-retouch advanced runtime status tests passed');
