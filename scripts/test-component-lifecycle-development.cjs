const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createComponentLifecycleService } = require('../electron/services/component-lifecycle-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-lifecycle-development-'));
const entryDirectory = path.join(root, 'advanced-installer');
const entry = path.join(entryDirectory, 'setup.ps1');
const manifestPath = path.join(root, 'component.template.json');
fs.mkdirSync(entryDirectory);
fs.writeFileSync(entry, 'Write-Output "ok"\n');
const digest = crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
const manifest = { id: 'fixture', version: '1', componentHost: { service: { lifecycleActions: { preflight: { entry: 'advanced-installer/setup.ps1', sha256: digest } } } } };
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

const component = { id: 'fixture', installed: true, compatible: true, version: '1', source: 'development', integrityStatus: 'development', path: root, manifestPath };
let packagedVerifierCalls = 0;
const pluginService = { list: () => [component], verifyComponentDirectoryAsync: async () => { packagedVerifierCalls += 1; throw new Error('packaged verifier must not run'); } };
const backgroundTasks = { run: async (_definition, execute) => ({ task: { id: 'task' }, result: await execute({ report() {} }) }) };
const spawn = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); process.nextTick(() => child.emit('exit', 0)); return child; };
const service = createComponentLifecycleService({ app: { getPath: () => path.join(root, 'user-data') }, backgroundTasks, pluginService, spawn, environment: { LOCALAPPDATA: path.join(root, 'local') } });
const descriptor = { componentId: 'fixture', componentVersion: '1', componentRoot: root, development: true, service: { permissions: ['component.lifecycle.manage'], events: [], lifecycleActions: { preflight: { entry, relativeEntry: 'advanced-installer/setup.ps1', sha256: digest } } } };

(async () => {
  try {
    assert.equal((await service.invoke({ action: 'preflight' }, {}, descriptor)).success, true);
    assert.equal(packagedVerifierCalls, 0, 'development lifecycle does not require a generated component.json');
    manifest.componentHost.service.lifecycleActions.preflight.sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(service.invoke({ action: 'preflight' }, {}, descriptor), /清单已变化/);
    console.log('Development component lifecycle manifest verification tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
