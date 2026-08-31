const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PythonDatabaseClient } = require('../electron/repositories/database-client.cjs');
const { WorkspaceSqliteCoordinator } = require('../electron/services/workspace-sqlite-coordinator.cjs');
const { createDomainHealthService } = require('../electron/services/domain-health-service.cjs');

const registry = createDomainHealthService();
const client = new PythonDatabaseClient({
  coordinator: new WorkspaceSqliteCoordinator(),
  getRunConfig: () => ({ command: 'unused', args: [] }), getDatabasePath: () => 'unused.sqlite3',
  writeLog: () => undefined, domainId: 'sample-component', circuitCooldownMs: 60000,
  onHealthChange: state => registry.update('sample-component', state),
});
client.noteFailure(new Error('database disk image is malformed'));
client.noteFailure(new Error('database disk image is malformed'));
assert.strictEqual(client.status().state, 'degraded');
client.noteFailure(new Error('database disk image is malformed'));
assert.strictEqual(client.status().state, 'unavailable');
assert.throws(() => client.assertCircuitAvailable(), error => error.code === 'DOMAIN_UNAVAILABLE');
assert.strictEqual(registry.get('sample-component').state, 'unavailable');
client.noteSuccess();
assert.strictEqual(client.status().state, 'healthy');
const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
const bannerSource = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'DomainHealthBanner.tsx'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
const systemIpcSource = fs.readFileSync(path.join(root, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
assert(appSource.includes('<DomainHealthBanner') && bannerSource.includes('getDomainHealth') && bannerSource.includes('部分功能已隔离') && bannerSource.includes('retryDomainCommand'), 'renderer must expose domain degradation and dead-letter recovery');
assert(preloadSource.includes("ipcRenderer.invoke('domain-command-retry'") && systemIpcSource.includes("ipcMain.handle('domain-command-retry'"), 'dead-letter retry must use a bounded IPC channel');
assert(bannerSource.includes('setTimeout') && !bannerSource.includes('setInterval'), 'health polling must wait for each request before scheduling the next');
assert(bannerSource.includes('retryBusy') && bannerSource.includes('Promise.allSettled'), 'dead-letter retry exposes busy state and contains per-command rejections');
console.log('Domain health and circuit-breaker tests passed.');
