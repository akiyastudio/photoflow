const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createComponentLifecycleService } = require('../electron/services/component-lifecycle-service.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-lifecycle-'));
const componentRoot = path.join(sandbox, 'component');
const actionRoot = path.join(sandbox, 'actions');
const scriptPath = path.join(actionRoot, 'fixture-action.ps1');
fs.mkdirSync(componentRoot, { recursive: true });
fs.mkdirSync(actionRoot, { recursive: true });
fs.writeFileSync(scriptPath, "param([switch]$CheckOnly)\nif (-not $CheckOnly) { throw 'fixed argument missing' }\nWrite-Output 'OFFLINE_PREFLIGHT_OK|real process|fixed action'\n", 'utf8');
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
  runJson: async () => ({ pairDetrReady: true, sam2Ready: true }),
};
const service = createComponentLifecycleService({ app: {}, backgroundTasks, pluginService, spawn, developmentActionRoot: actionRoot });
const descriptor = {
  componentId: 'team-retouch', componentVersion: '1.0.0',
  service: { lifecycleActions: { 'advanced.preflight': { entry: path.join(componentRoot, 'advanced-installer', 'fixture-action.ps1'), relativeEntry: 'advanced-installer/fixture-action.ps1', sha256: digest } } },
};

(async () => {
  try {
    const result = await service.invoke({ action: 'advanced.preflight' }, {}, descriptor);
    assert.equal(result.success, true);
    assert.match(result.message, /real process/);
    assert.equal(result.taskId, 'task-real-process');
    assert(progress.length >= 2, 'real lifecycle process must report through the task center');
    await assert.rejects(service.invoke({ action: 'advanced.preflight', script: 'C:/escape.ps1' }, {}, descriptor), /不接受脚本或路径参数/);
    await assert.rejects(service.resolveAction({ ...descriptor, service: { lifecycleActions: { 'advanced.preflight': { ...descriptor.service.lifecycleActions['advanced.preflight'], sha256: '0'.repeat(64) } } } }, 'advanced.preflight'), /签名\/哈希校验失败/);
    const escaped = { ...descriptor, service: { lifecycleActions: { 'advanced.preflight': { entry: scriptPath, relativeEntry: '../actions/fixture-action.ps1', sha256: digest } } } };
    component.source = 'user';
    await assert.rejects(service.resolveAction(escaped, 'advanced.preflight'), /escapes verified component root/);
    console.log('Component lifecycle real-process, signature, and path-boundary tests passed');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
