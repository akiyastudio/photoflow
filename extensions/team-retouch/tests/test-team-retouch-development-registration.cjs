const assert = require('node:assert/strict');
const path = require('node:path');
const { inspectDevelopmentComponent } = require('../../../electron/component-development.cjs');
const { parseComponentHostManifest } = require('../../../electron/component-host-contract.cjs');

const root = path.resolve(__dirname, '..');
const development = inspectDevelopmentComponent(root);
const descriptor = parseComponentHostManifest(development.manifest, root, { componentRoot: root, files: development.files });
assert.equal(development.id, 'team-retouch');
assert.equal(descriptor.contractVersion, 2);
assert.equal(descriptor.fullPage.entry, path.join(root, 'dist', 'ui', 'index.html'));
assert.equal(descriptor.settingsForms.length, 0);
assert.equal(descriptor.settingsPages[0].id, 'settings');
assert.equal(descriptor.settingsPages[0].title, '团片协作设置');
assert.equal(descriptor.settingsPages[0].entry, path.join(root, 'dist', 'ui', 'settings.html'));
assert.equal(descriptor.service.entry, path.join(root, 'service.cjs'));
assert.equal(development.command, path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'));
console.log('Team-retouch generic development registration smoke passed');
