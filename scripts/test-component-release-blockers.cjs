const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { terminateAndWait } = require('../electron/infrastructure/process-termination.cjs');
const { ComponentServiceManager } = require('../electron/services/component-service-manager.cjs');
const { ComponentViewManager, componentPartition } = require('../electron/services/component-view-manager.cjs');
const { registerComponentHostIpc } = require('../electron/modules/component-host-ipc.cjs');
const { normalizeComponentNotificationRendererEvent } = require('../electron/contracts/component-notification-renderer-event.cjs');

const child = pid => Object.assign(new EventEmitter(), {
  pid, exitCode: null, signalCode: null,
  stdin: { end() {}, destroy() {} },
  kill() { throw new Error('Windows fallback must not kill only the parent'); },
});
const bounded = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === 'ESRCH') return false; throw error; } };
const cleanupWindowsFixture = async (parent, descendantPid) => {
  const failures = [];
  for (const [label, pid, stop] of [
    ['grandchild', descendantPid, () => process.kill(descendantPid, 'SIGKILL')],
    ['parent', parent?.pid, () => parent.kill('SIGKILL')],
  ]) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { if (processAlive(pid) && stop() === false) throw new Error(`${label} refused direct termination`); }
    catch (error) { if (error?.code !== 'ESRCH') failures.push(new Error(`Failed to clean up Windows fixture ${label} ${pid}`, { cause: error })); }
  }
  for (const stream of [parent?.stdin, parent?.stdout, parent?.stderr]) { try { stream?.destroy?.(); } catch (error) { failures.push(error); } }
  if (parent && parent.exitCode === null && parent.signalCode === null) {
    try { await bounded(new Promise(resolve => parent.once('close', resolve)), 1000, 'Windows fixture close'); } catch (error) { failures.push(error); }
  }
  return failures;
};

(async () => {
  const owned = child(4242); const taskkillCalls = [];
  const result = await terminateAndWait(owned, Date.now() + 500, { platform: 'win32', rollbackSettleMs: 0, execFileImpl: (command, args, options, callback) => {
    taskkillCalls.push({ command, args, options }); owned.exitCode = 1; owned.emit('exit', 1, null); callback(null);
  } });
  assert.deepEqual(result, { exited: true, forced: true });
  assert.deepEqual(taskkillCalls[0].args, ['/pid', '4242', '/t', '/f']);
  assert.equal(taskkillCalls[0].options.windowsHide, true);

  const retryable = child(4343); let attempt = 0;
  const execFileImpl = (_command, args, _options, callback) => {
    assert.equal(args[1], '4343', 'tree termination never targets an unrelated PID');
    if (++attempt === 1) callback(new Error('taskkill failed'));
    else { retryable.exitCode = 1; retryable.emit('exit', 1, null); callback(null); }
  };
  await assert.rejects(terminateAndWait(retryable, Date.now() + 500, { platform: 'win32', rollbackSettleMs: 0, execFileImpl }), error => error.code === 'PROCESS_TREE_TERMINATION_FAILED');
  assert.equal(retryable.exitCode, null, 'failed tree termination preserves a live process for a safe retry');
  await terminateAndWait(retryable, Date.now() + 500, { platform: 'win32', rollbackSettleMs: 0, execFileImpl });
  assert.equal(attempt, 2);

  if (process.platform === 'win32' && process.env.PHOTOFLOW_TEST_REAL_PROCESS_TREE !== '0') {
    let parent = null; let descendantPid = null; let primaryError = null;
    try {
      await bounded((async () => {
        parent = spawn(process.execPath, ['-e', "const{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)"], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        descendantPid = await bounded(new Promise((resolve, reject) => { let buffer = ''; parent.stdout.on('data', chunk => { buffer += chunk; const line = buffer.split(/\r?\n/)[0]; if (/^\d+$/.test(line)) resolve(Number(line)); }); parent.once('error', reject); }), 3000, 'descendant PID');
        await terminateAndWait(parent, Date.now() + 5000, { rollbackSettleMs: 25 });
        await bounded(new Promise(resolve => setTimeout(resolve, 100)), 250, 'termination settle');
        assert.equal(processAlive(descendantPid), false, 'Windows termination kills the owned component service descendant tree');
      })(), 6500, 'Windows process-tree fixture');
    } catch (error) { primaryError = error; }
    const cleanupFailures = await cleanupWindowsFixture(parent, descendantPid);
    if (primaryError && cleanupFailures.length) throw new AggregateError([primaryError, ...cleanupFailures], `${primaryError.message}; Windows fixture cleanup also failed`, { cause: primaryError });
    if (primaryError) throw primaryError;
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Windows fixture cleanup failed');
  }

  const serviceManager = new ComponentServiceManager({ registry: {}, processSupervisor: {}, capabilityBroker: {} });
  let stopAttempt = 0; const session = { managed: { stop: async () => { if (++stopAttempt === 1) throw new Error('unconfirmed'); } } };
  serviceManager.sessions.set('fixture', session);
  await assert.rejects(serviceManager.stop('fixture'));
  assert.equal(serviceManager.sessions.get('fixture'), session, 'failed stop retains the owned session and PID evidence');
  assert.equal(await serviceManager.stop('fixture'), true);
  assert.equal(serviceManager.sessions.has('fixture'), false);

  const cleared = []; const persistentSession = { clearStorageData: async () => cleared.push('storage'), clearCache: async () => cleared.push('cache'), clearAuthCache: async () => cleared.push('auth') };
  const viewManager = new ComponentViewManager({ WebContentsView: function unused() {}, mainWindow: {}, registry: {}, preloadPath: '', ipcMain: { handle() {} }, partitionSessionProvider: name => { assert.equal(name, 'persist:component-host-fixture'); return persistentSession; } });
  assert.equal(componentPartition('fixture'), 'persist:component-host-fixture');
  assert.throws(() => componentPartition('FiXtUrE'), /Invalid component partition identifier/);
  assert.equal(await viewManager.clearComponentPartitionStorage('fixture'), true);
  assert.deepEqual(cleared, ['storage', 'cache', 'auth'], 'persistent partition is cleared even when no page opened this process');

  const handlers = new Map(); const frame = {}; const webContents = { mainFrame: frame }; const activations = [];
  registerComponentHostIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, mainWindow: { isDestroyed: () => false, webContents }, manager: { activate: id => (activations.push(['activate', id]), true), deactivateIfActive: id => (activations.push(['conditional', id]), true) } });
  const event = { sender: webContents, senderFrame: frame };
  const activate = handlers.get('component-host-activate');
  assert.deepEqual(activate(event, { instanceId: 'one' }), { success: true });
  assert.deepEqual(activate(event, { instanceId: 'one', deactivateIfActive: true }), { success: true });
  assert.throws(() => activate(event, 'one'), /Invalid component host request/);
  assert.throws(() => activate(event, { instanceId: 'one', legacy: true }), /Invalid component host request/);
  assert.deepEqual(activations, [['activate', 'one'], ['conditional', 'one']]);

  const notification = { type: 'notification', id: 'fixture:1', componentId: 'fixture', surface: 'project', notification: { tone: 'info', message: 'ok' } };
  assert(normalizeComponentNotificationRendererEvent(notification));
  assert.equal(normalizeComponentNotificationRendererEvent({ ...notification, apiVersion: 7 }), null);
  assert.equal(normalizeComponentNotificationRendererEvent({ type: 'purge', componentId: 'fixture', apiVersion: 7 }), null);
  const uninstallSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  assert(uninstallSource.includes('await componentViewManager?.clearComponentPartitionStorage?.(componentId)') && uninstallSource.includes("cleanupWarnings.push(`组件浏览器分区"), 'uninstall awaits partition cleanup and reports failures');
  assert(uninstallSource.includes('componentDataRoot(app, componentId, process.env)') && uninstallSource.includes("error?.code !== 'ENOENT'"), 'clear-user-data covers lifecycle data and records non-missing probe failures');
  console.log('Component release-blocker regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
