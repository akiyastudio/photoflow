const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { createProtectedProjectFolderRegistry } = require('../electron/services/protected-project-folder.cjs');
const { createPersistentRenameService } = require('../electron/services/persistent-rename-service.cjs');
const { createFilePublicationService } = require('../electron/services/file-publication-service.cjs');
const { createComponentRegistry } = require('../electron/component-registry.cjs');

(async () => {
  let revision = 1; let reads = 0;
  let descriptors = [{ service: { projectFolders: [{ name: 'Output', protectFromGenericRename: true }] } }];
  const policies = createProtectedProjectFolderRegistry({ descriptorProvider: () => { reads++; return descriptors; }, descriptorRevisionProvider: () => revision });
  assert(policies.isProtectedProjectFolderName('Output'));
  assert(policies.isProtectedProjectFolderName('output'));
  assert.equal(reads, 1, 'unchanged policy metadata reuses validated names');
  descriptors = [{ service: { projectFolders: [{ name: 'New output', protectFromGenericRename: true, reserveProgressRelocationName: true }] } }];
  revision++;
  assert(policies.isProtectedProjectFolderName('New output'));
  assert(!policies.isProtectedProjectFolderName('Output'));
  assert(policies.progressRelocationReservedNames().includes('new output'));
  assert.equal(reads, 2, 'policy changes take effect immediately');

  let launchCount = 0; let requests = 0; let terminated = 0;
  let mode = 'success';
  const worker = createPersistentRenameService({ timeoutMs: 100, idleMs: 0,
    launch: () => {
      launchCount++;
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()); requests++; callback();
        queueMicrotask(() => {
          if (mode === 'timeout') return;
          if (mode === 'malformed') { child.stdout.write('null\n'); return; }
          if (mode === 'disconnect') { child.emit('close', 1); return; }
          const result = mode === 'collision' ? { success: false, code: 'EEXIST', error: 'exists' } : { success: true };
          child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
        });
      } });
      queueMicrotask(() => child.stdout.write('{"ready":true,"protocol":"photoflow-rename-v1"}\n'));
      return child;
    }, terminate: async () => { terminated++; },
  });
  await worker.warm();
  assert((await Promise.all([worker.move('a', 'b'), worker.move('b', 'c')])).every(result => result.success));
  assert.equal(launchCount, 1, 'consecutive and queued renames reuse one process');
  mode = 'collision';
  await assert.rejects(worker.move('c', 'occupied'), error => error.code === 'EEXIST' && !error.outcomeUnknown);
  mode = 'success'; await worker.move('c', 'd');
  mode = 'timeout';
  const beforeTimeout = requests;
  await assert.rejects(worker.move('d', 'timeout'), error => error.outcomeUnknown === true && error.code === 'FILE_PUBLICATION_TIMEOUT');
  assert.equal(requests, beforeTimeout + 1, 'timed out mutations are not replayed');
  mode = 'malformed';
  await assert.rejects(worker.move('d', 'malformed'), error => error.outcomeUnknown === true);
  mode = 'disconnect';
  const before = requests;
  await assert.rejects(worker.move('d', 'e'), error => error.outcomeUnknown === true);
  assert.equal(requests, before + 1, 'an uncertain mutation must never be automatically replayed');
  assert.equal(terminated, 3);
  await worker.stop();
  await assert.rejects(worker.move('e', 'f'), /停止/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-rename-fast-'));
  let native;
  try {
    const componentRoot = path.join(root, 'components'); fs.mkdirSync(componentRoot);
    const registry = createComponentRegistry({ projectRoot: path.resolve(__dirname, '..'), userComponentRoot: componentRoot, isPackaged: true });
    const firstRevision = registry.hostPolicyRevision();
    const runtime = path.join(componentRoot, 'fixture', 'runtime'); fs.mkdirSync(runtime, { recursive: true });
    const manifest = path.join(runtime, 'component.json'); fs.writeFileSync(manifest, '{}');
    const installedRevision = registry.hostPolicyRevision();
    assert.notEqual(installedRevision, firstRevision, 'installing a component invalidates folder policies');
    fs.writeFileSync(manifest, '{"version":"2"}');
    assert.notEqual(registry.hostPolicyRevision(), installedRevision, 'editing a manifest invalidates folder policies');
    if (process.platform === 'win32') {
      let nativeLaunches = 0;
      native = createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..'), persistentRename: true,
        spawnImpl: (...args) => { nativeLaunches++; return spawn(...args); } });
      const source = path.join(root, '原始 文件夹'); const target = path.join(root, '重命名 文件夹');
      fs.mkdirSync(source); fs.writeFileSync(path.join(source, '保留.txt'), 'retain');
      await native.warmRename();
      await native.moveNoReplace(source, target);
      assert.equal(fs.readFileSync(path.join(target, '保留.txt'), 'utf8'), 'retain');
      fs.mkdirSync(source);
      await assert.rejects(native.moveNoReplace(target, source), error => ['EEXIST', 'EBUSY'].includes(error.code));
      assert(fs.existsSync(target) && fs.existsSync(source), 'a target collision preserves both directories');
      for (let index = 0; index < 6; index++) await native.moveNoReplace(index % 2 ? target + '-next' : target, index % 2 ? target : target + '-next');
      assert.equal(nativeLaunches, 1, 'the real native helper reuses its process while preserving no-clobber semantics');
    }
  } finally { await native?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  console.log('rename fast paths and native worker tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
