const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../electron/services/rename-performance-diagnostics.cjs');
const disabled = spawnSync(process.execPath, ['-e', `const assert = require('node:assert/strict'); const {instrumentRenameContext} = require(${JSON.stringify(modulePath)}); const context = {}; assert.equal(instrumentRenameContext(context), context);`], {
  env: { ...process.env, PHOTOFLOW_SMOKE_TEST: '0', PHOTOFLOW_RENAME_BENCHMARK: '1' }, encoding: 'utf8', windowsHide: true,
});
assert.equal(disabled.status, 0, disabled.stderr);
process.env.PHOTOFLOW_SMOKE_TEST = '1';
process.env.PHOTOFLOW_RENAME_BENCHMARK = '1';
const { instrumentRenameContext, records } = require(modulePath);

(async () => {
  const handlers = new Map();
  const expected = { success: true, opaque: {} };
  const context = instrumentRenameContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getProjectPath: () => 'private-path',
    projectVirtualPaths: { resolve: () => ({ physicalPath: 'private-path' }) },
    versionService: { listProgress: async () => expected },
    publishPathNoClobber: async () => expected,
  });
  context.ipcMain.handle('workspace-file-operation', async () => {
    assert.equal(context.getProjectPath(), 'private-path', 'sync return types must be preserved');
    assert.deepEqual(context.projectVirtualPaths.resolve(), { physicalPath: 'private-path' });
    assert.equal(await context.versionService.listProgress(), expected);
    return context.publishPathNoClobber();
  });
  const fileOperation = handlers.get('workspace-file-operation');
  assert.equal(await fileOperation(null, '', '', '', 'copy'), expected);
  assert.equal(records.length, 0, 'unrelated operations do not generate reports');
  assert.equal(await fileOperation(null, '', '', '', 'rename'), expected);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'ordinary');
  assert.equal(records[0].success, true);
  assert.deepEqual(records[0].stages.map(row => row.stage), ['getProjectPath', 'virtualPath.resolve', 'registeredProgressQuery', 'nativeRenameIncludingProcessStartup']);
  assert(records[0].stages.every(stage => stage.durationMs >= 0 && stage.startMs >= 0));
  assert(!JSON.stringify(records).includes('private-path'), 'trace records must not contain path arguments or results');
  const expectedError = new Error('expected failure');
  context.ipcMain.handle('workspace-progress-folder-rename', () => { throw expectedError; });
  await assert.rejects(handlers.get('workspace-progress-folder-rename')(), error => error === expectedError);
  assert.equal(records[1].kind, 'progress');
  assert.equal(records[1].success, false);
  assert.equal(records[1].finished, true, 'a failed operation must still close its timing scope');
  const before = records[0].stages.length;
  await context.publishPathNoClobber();
  assert.equal(records[0].stages.length, before, 'calls outside an active rename do not leak into earlier measurements');
  console.log('rename performance diagnostics tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
