const assert = require('node:assert/strict');
const { npmInvocation } = require('../scripts/npm-invocation.cjs');

const windows = npmInvocation({ platform: 'win32', nodeExecutable: 'C:\\Node\\node.exe', npmCli: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js' });
assert.deepEqual(windows, {
  command: 'C:\\Node\\node.exe',
  argsPrefix: ['C:\\Node\\node_modules\\npm\\bin\\npm-cli.js'],
});
assert.throws(() => npmInvocation({ platform: 'win32', npmCli: '' }), /npm_execpath/);
assert.deepEqual(npmInvocation({ platform: 'linux' }), { command: 'npm', argsPrefix: [] });

console.log('Team-retouch cross-platform npm invocation tests passed');
