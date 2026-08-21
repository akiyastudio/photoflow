const assert = require('assert/strict');
const { probeManyIndividually } = require('../electron/services/recycle-bin-service.cjs');

const run = async () => {
  const result = await probeManyIndividually(['broken', 'valid'], async pidl => {
    if (pidl === 'broken') throw new Error('invalid PIDL');
    return { success: true, exists: true, name: 'valid item' };
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.items[0], { success: false, exists: false, pidl: 'broken', error: 'invalid PIDL' });
  assert.equal(result.items[1].pidl, 'valid');
  assert.equal(result.items[1].exists, true);
  process.stdout.write('Recycle-bin batch probe tests passed.\n');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
