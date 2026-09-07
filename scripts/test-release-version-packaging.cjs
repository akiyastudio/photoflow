const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const {
  discoverComponentModules, packageModule, replaceVersionFields, appModule,
} = require('./manage-release-versions.cjs');

// Capture commands without building packages or changing the checkout's versions.
const components = discoverComponentModules();
const team = components.find(component => component.id === 'team-retouch');
assert.ok(team, 'Team retouch must be discoverable by the version updater');
const calls = [];
const capture = (...args) => calls.push(args);
packageModule(team, capture);
assert.deepEqual(calls.pop(), [
  ['run', 'build:components', '--', '--only', 'team-retouch', '--variant', 'base'],
  path.resolve(__dirname, '..'), team.label,
]);

for (const component of components.filter(component => component.id !== team.id)) {
  packageModule(component, capture);
  assert.deepEqual(calls.pop()[0], ['run', 'build:components', '--', '--only', component.id]);
}
packageModule(appModule, capture);
assert.deepEqual(calls.pop(), [appModule.build.args, appModule.build.cwd, appModule.label]);

const updated = JSON.parse(replaceVersionFields(JSON.stringify({
  version: '26.9.4', advancedRuntime: { packageVersion: '26.9.4' },
}), '26.9.7', 1));
assert.equal(updated.version, '26.9.7');
assert.equal(updated.advancedRuntime.packageVersion, '26.9.4');

// Exercise the real base entry point with child processes intercepted. Importing
// its argument parser must not trigger the advanced release-lock validation.
const baseEntry = path.resolve(__dirname, '../extensions/team-retouch/scripts/package-base.cjs');
const baseRequire = createRequire(baseEntry);
const baseCalls = [];
vm.runInNewContext(fs.readFileSync(baseEntry, 'utf8'), {
  __dirname: path.dirname(baseEntry),
  process: { execPath: process.execPath, argv: [process.execPath, baseEntry] },
  require: name => name === 'node:child_process'
    ? { spawnSync: (...args) => { baseCalls.push(args); return { status: 0 }; } }
    : baseRequire(name),
}, { filename: baseEntry });
assert.equal(baseCalls.length, 2);
assert.equal(path.basename(baseCalls[0][1][0]), 'setup-python.cjs');
assert.deepEqual(Array.from(baseCalls[1][1]), [
  path.join(path.dirname(baseEntry), 'package-component.cjs'), '--output-dir',
  path.resolve(__dirname, '../artifacts/installers'),
]);
console.log('Version updater packaging routes passed; no packages generated.');
