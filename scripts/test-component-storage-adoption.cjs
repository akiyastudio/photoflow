const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { adoptLegacyStorageV1, transactionPaths } = require('../electron/services/component-storage-adoption.cjs');

const simulatedCrash = stage => {
  const error = new Error(`simulated crash ${stage}`);
  error.code = 'SIMULATED_PROCESS_CRASH';
  throw error;
};
const runBoundary = async stage => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'component-storage-adoption-'));
  try {
    const dataRoot = path.join(root, 'workspace-data');
    const componentRoot = path.join(dataRoot, 'components', 'sample-component');
    const legacyRoot = path.join(dataRoot, 'sample-component');
    const legacyDatabase = path.join(dataRoot, 'databases', 'sample-component.sqlite3');
    await fs.promises.mkdir(componentRoot, { recursive: true });
    await fs.promises.mkdir(legacyRoot, { recursive: true });
    await fs.promises.mkdir(path.dirname(legacyDatabase), { recursive: true });
    await fs.promises.writeFile(path.join(componentRoot, 'current.txt'), 'current');
    await fs.promises.writeFile(path.join(legacyRoot, 'private.bin'), 'legacy-private');
    await fs.promises.writeFile(legacyDatabase, 'legacy-database');
    const descriptor = { componentId: 'sample-component' };
    await assert.rejects(adoptLegacyStorageV1({ fs, path, crypto, dataRoot, componentRoot, descriptor, faultInjector: current => current === stage ? simulatedCrash(current) : undefined }), /simulated crash/);
    const result = await adoptLegacyStorageV1({ fs, path, crypto, dataRoot, componentRoot, descriptor });
    assert.equal(result.state, 'committed');
    assert.equal(await fs.promises.readFile(path.join(componentRoot, 'private.bin'), 'utf8'), 'legacy-private');
    assert.equal(await fs.promises.readFile(path.join(componentRoot, 'storage.sqlite3'), 'utf8'), 'legacy-database');
    assert.equal(await fs.promises.readFile(legacyDatabase, 'utf8'), 'legacy-database', 'legacy database source must be retained');
    assert.equal(await fs.promises.readFile(path.join(legacyRoot, 'private.bin'), 'utf8'), 'legacy-private', 'legacy private source must be retained');
    const transaction = transactionPaths(path, componentRoot, descriptor.componentId);
    assert.equal(fs.existsSync(transaction.journal), false);
    assert.equal(fs.existsSync(transaction.pending), false);
    assert.equal(fs.existsSync(transaction.previous), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
};

(async () => {
  for (const stage of ['before-journal', 'after-prepared', 'after-previous-rename', 'after-commit-rename']) await runBoundary(stage);
  const orphanRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'component-storage-orphan-'));
  try {
    const dataRoot = path.join(orphanRoot, 'data');
    const componentRoot = path.join(dataRoot, 'components', 'sample-component');
    const legacyRoot = path.join(dataRoot, 'sample-component');
    const descriptor = { componentId: 'sample-component' };
    const transaction = transactionPaths(path, componentRoot, descriptor.componentId);
    await fs.promises.mkdir(componentRoot, { recursive: true });
    await fs.promises.mkdir(transaction.pending, { recursive: true });
    await fs.promises.mkdir(legacyRoot, { recursive: true });
    await fs.promises.writeFile(path.join(transaction.pending, 'partial.bin'), 'partial');
    await fs.promises.writeFile(`${transaction.journal}.crash.tmp`, '{partial');
    await fs.promises.writeFile(path.join(legacyRoot, 'complete.bin'), 'complete');
    await adoptLegacyStorageV1({ fs, path, crypto, dataRoot, componentRoot, descriptor });
    assert.equal(await fs.promises.readFile(path.join(componentRoot, 'complete.bin'), 'utf8'), 'complete');
    assert.equal(fs.existsSync(`${transaction.journal}.crash.tmp`), false, 'orphan journal temporary must be removed');
  } finally { await fs.promises.rm(orphanRoot, { recursive: true, force: true }); }

  const symlinkRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'component-storage-symlink-'));
  try {
    const dataRoot = path.join(symlinkRoot, 'data');
    const componentRoot = path.join(dataRoot, 'components', 'sample-component');
    const external = path.join(symlinkRoot, 'external');
    await fs.promises.mkdir(path.dirname(componentRoot), { recursive: true });
    await fs.promises.mkdir(external, { recursive: true });
    await fs.promises.symlink(external, path.join(dataRoot, 'sample-component'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(adoptLegacyStorageV1({ fs, path, crypto, dataRoot, componentRoot, descriptor: { componentId: 'sample-component' } }), /unsafe|symbolic/i);
  } finally { await fs.promises.rm(symlinkRoot, { recursive: true, force: true }); }
  console.log('Component storage V1 adoption crash recovery tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
