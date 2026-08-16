const assert = require('assert');
const { PythonDatabaseClient } = require('../electron/repositories/database-client.cjs');
const { createDomainHealthService } = require('../electron/services/domain-health-service.cjs');

const registry = createDomainHealthService();
const client = new PythonDatabaseClient({
  getRunConfig: () => ({ command: 'unused', args: [] }), getDatabasePath: () => 'unused.sqlite3',
  writeLog: () => undefined, domainId: 'team-retouch', circuitCooldownMs: 60000,
  onHealthChange: state => registry.update('team-retouch', state),
});
client.noteFailure(new Error('database disk image is malformed'));
client.noteFailure(new Error('database disk image is malformed'));
assert.strictEqual(client.status().state, 'degraded');
client.noteFailure(new Error('database disk image is malformed'));
assert.strictEqual(client.status().state, 'unavailable');
assert.throws(() => client.assertCircuitAvailable(), error => error.code === 'DOMAIN_UNAVAILABLE');
assert.strictEqual(registry.get('team-retouch').state, 'unavailable');
client.noteSuccess();
assert.strictEqual(client.status().state, 'healthy');
console.log('Domain health and circuit-breaker tests passed.');

