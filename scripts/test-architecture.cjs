const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEventBus } = require('../electron/services/event-bus.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { PLUGIN_DEFINITIONS, findPluginByCapability } = require('../electron/plugins/plugin-catalog.cjs');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const lines = value => value.split(/\r?\n/).length;

const main = read('electron/main.cjs');
const app = read('src/App.tsx');
assert(!/ipcMain\.(?:handle|on)\s*\(/.test(main), 'main.cjs must not own IPC handlers');
assert(lines(main) < 2000, 'main.cjs exceeded the architecture size budget');
assert(lines(app) < 1000, 'App.tsx exceeded the architecture size budget');
assert(!/run(?:Workspace|Media)Database/.test(`${main}\n${read('electron/modules/workspace-ipc.cjs')}\n${read('electron/modules/versions-ipc.cjs')}`), 'IPC code bypassed repositories');

const electronSources = fs.readdirSync(path.join(root, 'electron'), { recursive: true })
  .filter(name => name.endsWith('.cjs'))
  .map(name => read(path.join('electron', name)))
  .join('\n');
const registeredChannels = new Set([...electronSources.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]));
const preload = read('electron/preload.cjs');
const requestedChannels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
for (const channel of requestedChannels) assert(registeredChannels.has(channel), `preload channel is not registered: ${channel}`);

assert(findPluginByCapability('team-retouch.detect')?.id === 'team-retouch');
assert(findPluginByCapability('research.organize')?.id === 'research-tools');
assert(Object.values(PLUGIN_DEFINITIONS).every(plugin => Array.isArray(plugin.capabilities) && plugin.capabilities.length));

const testBackgroundTasks = async () => {
  const eventBus = createEventBus();
  const service = createBackgroundTaskService({ eventBus, maxHistory: 10 });
  const updates = [];
  eventBus.on('background-task:changed', task => updates.push(task));

  const completed = await service.run({ type: 'test', title: 'test task' }, async task => {
    task.report(50, 'half');
    return 42;
  });
  assert.strictEqual(completed.result, 42);
  assert.strictEqual(completed.task.state, 'completed');
  assert(updates.some(task => task.progress === 50));

  let attempts = 0;
  let retryRun;
  retryRun = () => service.run({ type: 'retry-test', title: 'retry test' }, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('first attempt fails');
    return 'retried';
  }, retryRun);
  let failedId = '';
  try {
    await retryRun();
  } catch {
    failedId = service.list().find(task => task.type === 'retry-test')?.id || '';
  }
  assert(failedId, 'failed task was not retained');
  const retried = await service.retry(failedId);
  assert.strictEqual(retried.result, 'retried');

  const cancelling = service.run({ type: 'cancel-test', title: 'cancel test' }, task => new Promise(resolve => {
    task.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  }));
  await new Promise(resolve => setImmediate(resolve));
  const cancelTask = service.list().find(task => task.type === 'cancel-test');
  assert(cancelTask && service.cancel(cancelTask.id));
  const cancelled = await cancelling;
  assert(cancelled.cancelled);
  service.stop();
  eventBus.clear();
};

testBackgroundTasks().then(() => console.log('Architecture contracts passed.')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
