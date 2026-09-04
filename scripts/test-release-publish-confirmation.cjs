const assert = require('node:assert/strict');
const { publishReleaseOnce } = require('./publish-release.cjs');

(async () => {
  const base = { url: 'https://release.invalid/v1/admin/releases', token: 'token', record: { version: '1.0.0' }, idempotencyKey: 'a'.repeat(64) };
  await assert.rejects(publishReleaseOnce({ ...base, request: async () => ({}) }), /saved=true|不确定/);
  await assert.rejects(publishReleaseOnce({ ...base, request: async () => { throw new DOMException('timeout', 'TimeoutError'); } }), /timeout/i);
  let serverSaved = false;
  await assert.rejects(publishReleaseOnce({ ...base, request: async () => { serverSaved = true; throw new Error('connection closed after save'); } }), /after save/);
  assert.equal(serverSaved, true);
  let options;
  assert.deepEqual(await publishReleaseOnce({ ...base, request: async (_url, value) => { options = value; return { saved: true }; } }), { saved: true });
  assert.equal(options.headers['Idempotency-Key'], base.idempotencyKey);
  console.log('Release publish confirmation and uncertain-outcome tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
