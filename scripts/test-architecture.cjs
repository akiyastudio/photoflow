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
const projectWorkspace = read('src/features/workspace/ProjectWorkspace.tsx');
const settingsFeature = read('src/features/settings/SettingsFeature.tsx');
const requirePlugin = read('src/features/plugins/RequirePlugin.tsx');
const packageJson = JSON.parse(read('package.json'));
assert(/\btsc\s+-b\b/.test(packageJson.scripts.build), 'production build must type-check referenced TypeScript projects');
assert(projectWorkspace.includes('folder.trackingEnabled && !folder.folderMissing'), 'version management must require an enabled, available progress tracker');
assert(/openVersions[\s\S]*?if \(!hasVersionTrackingForEntry\(target\)\)/.test(projectWorkspace), 'version management must guard every open path before creating media history');
assert(!/ipcMain\.(?:handle|on)\s*\(/.test(main), 'main.cjs must not own IPC handlers');
assert(lines(main) < 2000, 'main.cjs exceeded the architecture size budget');
assert(lines(app) < 1000, 'App.tsx exceeded the architecture size budget');
assert(!/run(?:Workspace|Media)Database/.test(`${main}\n${read('electron/modules/workspace-ipc.cjs')}\n${read('electron/modules/versions-ipc.cjs')}`), 'IPC code bypassed repositories');
assert.strictEqual((app.match(/electronAPI\.getComponents\(/g) || []).length, 1, 'App must be the single renderer owner of component status');
assert(!settingsFeature.includes('electronAPI.getComponents('), 'settings must consume App component state instead of fetching it');
assert(!projectWorkspace.includes('electronAPI.getComponents('), 'project workspace must consume App component state instead of fetching it');
assert(!requirePlugin.includes('electronAPI.getComponents('), 'component contributions must not independently fetch component state');
assert(app.includes("card !== 'research' || installedComponentIds.has('research-tools')"), 'research home contribution must be hidden when its component is not installed');
assert(!app.includes('尚未安装调研整理组件'), 'uninstalled component contributions must not leave placeholder UI');
assert(projectWorkspace.includes("teamRetouchAvailable && fileMenu.entry.kind === 'image'"), 'team retouch context-menu contribution must require the installed component');
assert(settingsFeature.includes('filter(item => installedComponentIds.has(item.componentId))'), 'component settings contributions must require the installed component');
assert(app.includes("componentSettings: { ...fileConfig.componentSettings, 'team-retouch': personDetectionSettings, 'research-tools': researchSettings }"), 'legacy component config must migrate into componentSettings');

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
