const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { advancedStateFromProbe, createComponentLifecycleService } = require('../electron/services/component-lifecycle-service.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-lifecycle-'));
const componentRoot = path.join(sandbox, 'component');
const actionRoot = path.join(sandbox, 'actions');
const scriptPath = path.join(actionRoot, 'fixture-action.ps1');
fs.mkdirSync(componentRoot, { recursive: true });
fs.mkdirSync(actionRoot, { recursive: true });
fs.writeFileSync(scriptPath, "param([switch]$CheckOnly,[string]$InstallRoot,[string]$PackagePath,[string]$ExpectedComponentVersion,[int]$ExpectedAdvancedRuntimeApiVersion,[string]$CompatibleLegacyComponentVersions,[switch]$Repair)\nif ($CheckOnly) { Write-Output 'OFFLINE_PREFLIGHT_OK|real process|fixed action'; exit 0 }\nif ($ExpectedAdvancedRuntimeApiVersion -ne 1 -or $CompatibleLegacyComponentVersions -ne '26.7.30.1') { throw 'advanced compatibility arguments missing' }\nWrite-Output 'offline environment is ready'\n", 'utf8');
fs.writeFileSync(path.join(componentRoot, 'PhotoFlow-team-retouch-advanced-legacy-win32-x64.zip'), 'fixture', 'utf8');
const digest = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
const progress = [];
const backgroundTasks = {
  run: async (definition, worker) => ({
    task: { id: 'task-real-process' },
    result: await worker({ report: (value, message, metadata) => progress.push({ value, message, metadata }) }),
  }),
};
const component = { id: 'team-retouch', installed: true, version: '1.0.0', source: 'development', path: componentRoot };
const pluginService = {
  list: () => [component],
  verifyComponentDirectoryAsync: async () => true,
  runJson: async () => ({ success: true, advancedAvailable: true, pairDetrReady: true, sam2Ready: true }),
};
const service = createComponentLifecycleService({ app: {}, backgroundTasks, pluginService, spawn, developmentActionRoot: actionRoot });
const descriptor = {
  componentId: 'team-retouch', componentVersion: '1.0.0',
  advancedRuntime: { apiVersion: 1, compatibleLegacyComponentVersions: ['26.7.30.1'] },
  service: { lifecycleActions: {
    'advanced.preflight': { entry: path.join(componentRoot, 'advanced-installer', 'fixture-action.ps1'), relativeEntry: 'advanced-installer/fixture-action.ps1', sha256: digest },
    'advanced.install': { entry: path.join(componentRoot, 'advanced-installer', 'fixture-action.ps1'), relativeEntry: 'advanced-installer/fixture-action.ps1', sha256: digest },
  } },
};

(async () => {
  try {
    const result = await service.invoke({ action: 'advanced.preflight' }, {}, descriptor);
    assert.equal(result.success, true);
    assert.deepEqual({ available: result.available, installed: result.installed, advancedAvailable: result.advancedAvailable, state: result.state, advancedError: result.advancedError }, { available: true, installed: true, advancedAvailable: true, state: 'ready', advancedError: '' }, 'preflight must return the renderer status contract rather than only prerequisite success');
    assert.match(result.message, /real process/);
    assert.equal(result.taskId, 'task-real-process');
    assert(progress.length >= 2, 'real lifecycle process must report through the task center');
    const installed = await service.invoke({ action: 'advanced.install' }, {}, descriptor);
    assert.equal(installed.success, true, 'advanced install must receive the runtime API and reviewed legacy compatibility list');
    await assert.rejects(service.invoke({ action: 'advanced.preflight', script: 'C:/escape.ps1' }, {}, descriptor), /不接受脚本或路径参数/);
    await assert.rejects(service.resolveAction({ ...descriptor, service: { lifecycleActions: { 'advanced.preflight': { ...descriptor.service.lifecycleActions['advanced.preflight'], sha256: '0'.repeat(64) } } } }, 'advanced.preflight'), /签名\/哈希校验失败/);
    const escaped = { ...descriptor, service: { lifecycleActions: { 'advanced.preflight': { entry: scriptPath, relativeEntry: '../actions/fixture-action.ps1', sha256: digest } } } };
    component.source = 'user';
    await assert.rejects(service.resolveAction(escaped, 'advanced.preflight'), /escapes verified component root/);
    assert.deepEqual(advancedStateFromProbe({ probe: { success: true, advancedAvailable: false, advancedError: 'models missing' }, vhdPresent: true }), { available: false, installed: true, advancedAvailable: false, state: 'repair-needed', advancedError: 'models missing' });
    assert.equal(advancedStateFromProbe({ probe: { success: false, error: 'distro missing' }, vhdPresent: false }).state, 'not-installed');
    console.log('Component lifecycle real-process, signature, and path-boundary tests passed');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
