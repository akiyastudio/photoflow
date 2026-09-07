const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createApplicationQuitUi } = require('../electron/services/application-quit-ui.cjs');
const { runApplicationQuit } = require('../electron/services/application-quit-coordinator.cjs');
const { normalizeTask } = require('../electron/services/background-task-migrations.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const run = async () => {
  const handlers = new Map(), states = [];
  const contents = { mainFrame: {}, isDestroyed: () => false, send: (_channel, state) => states.push(state) };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const ui = createApplicationQuitUi({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getMainWindow: () => ({ webContents: contents, isDestroyed: () => false }), timeoutMs: 100 });
  assert.throws(() => handlers.get('application-quit:state')({ sender: {}, senderFrame: {} }), /Unauthorized/);
  handlers.get('application-quit:state')(event);
  const cancelled = ui.confirmAndPrepare([{ id: 'job', title: '视频转码', state: 'running', progress: 42 }]);
  const request = states.at(-1);
  assert.equal(request.tasks[0].title, '视频转码');
  assert.equal(ui.confirmAndPrepare([]), cancelled, 'repeated close shares one decision');
  assert.equal(handlers.get('application-quit:respond')(event, 'stale', true).accepted, false);
  assert.throws(() => handlers.get('application-quit:respond')({ sender: {} }, request.requestId, true), /Unauthorized/);
  handlers.get('application-quit:respond')(event, request.requestId, false);
  assert.equal(await cancelled, false);
  const prepared = ui.confirmAndPrepare([]);
  handlers.get('application-quit:respond')(event, states.at(-1).requestId, true);
  assert.equal(await prepared, true);
  assert.equal(states.at(-1).phase, 'saving');
  await assert.rejects(ui.confirmAndPrepare([]), error => error.code === 'APP_QUIT_UI_TIMEOUT');

  const bus = new EventEmitter(); const deltas = [];
  bus.on('background-task:changed', value => deltas.push(value));
  const background = createBackgroundTaskService({ eventBus: bus });
  const workers = Array.from({ length: 30 }, (_, index) => background.run({ id: `scan-${index}`, type: 'version-media-rescan', title: `扫描 ${index}`, cancellable: true, concurrencyGroup: 'background-maintenance', concurrencyLimit: 1 }, task => new Promise((resolve, reject) => {
    task.signal.addEventListener('abort', () => reject(Object.assign(new Error('因退出停止'), { code: 'APP_SHUTTING_DOWN' })), { once: true });
  })));
  await delay(0);
  const before = deltas.length;
  background.beginShutdown();
  assert.throws(() => background.run({ type: 'version-media-rescan' }, async () => undefined), error => error.code === 'APP_SHUTTING_DOWN');
  await Promise.all(workers);
  assert.equal(deltas.length, before, 'quiescing never floods the renderer with terminal task deltas');
  assert(background.list().every(task => task.state === 'cancelled'), '30 queued/running automatic tasks stop without failures');
  background.stop();

  const safeTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
  const saving = safeTasks.create({ type: 'project-file-operation', title: '保存文件', cancellable: false });
  saving.startLifecycle();
  const stages = [];
  let hidden = false, processStops = 0;
  const context = {
    componentIds: [], backgroundTasks: safeTasks, confirmationAccepted: true,
    componentLifecycleCoordinator: { requestApplicationStop: () => undefined, waitForAllWork: async () => undefined, commitApplicationQuit: () => stages.push('commit'), cancelApplicationQuit: () => undefined },
    componentCapabilityBroker: { blockComponent: () => ({ drain: async () => undefined, release: () => undefined }) },
    processSupervisor: { list: () => [], stopAll: async (_reason, options) => { assert(Number.isFinite(options.deadlineAt)); processStops += 1; stages.push('processes'); await delay(50); } },
    componentServiceManager: { stopAll: async () => { stages.push('services'); await delay(50); } },
    quiesce: () => stages.push('quiesce'), saveState: () => stages.push('save'),
    hideWindow: () => { hidden = true; stages.push('hide'); },
    cleanup: [async () => { stages.push('cleanup'); await delay(50); }],
  };
  const closing = runApplicationQuit(context);
  await delay(25);
  assert.equal(hidden, true, 'the application surface disappears while critical file work finishes in the background');
  assert.equal(processStops, 0, 'file submission finishes before closing its worker');
  saving.complete();
  const outcome = await closing;
  assert.equal(outcome.committed, true);
  assert(stages.indexOf('quiesce') < stages.indexOf('hide') && stages.indexOf('hide') < stages.indexOf('save') && stages.indexOf('save') < stages.indexOf('processes'));
  assert(outcome.timings.completedMs < 250, 'independent cleanup runs concurrently');
  assert(outcome.timings.windowHiddenMs < 200);
  const oldFailure = { id: 'scan-error', type: 'version-media-rescan', title: '自动扫描', state: 'failed', error: 'Process supervisor is stopping' };
  assert.equal(normalizeTask(oldFailure).state, 'cancelled');
  assert.equal(normalizeTask({ ...oldFailure, error: 'disk is full' }).state, 'failed', 'real failures are preserved');
  console.log('Fast quit: trusted custom UI, stale responses, 30-task shutdown, critical save barrier, parallel cleanup and historical false-failure repair passed.');
};
run().catch(error => { console.error(error); process.exitCode = 1; });
