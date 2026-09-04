const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertComponentBuildReceipt, createStableManifest, verifyStagedRelease, assertStagedReleaseUnchanged } = require('./release-staging.cjs');
const { acquireReleaseLock, releaseLock } = require('./release-lock.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-release-staging-test-'));
const git = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

(async () => {
  try {
    const lock = acquireReleaseLock(root);
    assert.throws(() => acquireReleaseLock(root), /正在运行/);
    releaseLock(lock);
    const replacedLock = acquireReleaseLock(root);
    fs.renameSync(replacedLock.lockPath, `${replacedLock.lockPath}.owned`);
    fs.writeFileSync(replacedLock.lockPath, JSON.stringify({ schemaVersion: 1, pid: process.pid, host: os.hostname(), attemptId: crypto.randomUUID(), startedAt: new Date().toISOString() }));
    assert.throws(() => releaseLock(replacedLock), /已被替换/);
    assert(fs.existsSync(replacedLock.lockPath), 'release must not delete another session lock');
    fs.rmSync(replacedLock.lockPath); fs.rmSync(`${replacedLock.lockPath}.owned`);
    fs.writeFileSync(path.join(root, 'artifacts', 'release.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647, host: os.hostname(), attemptId: crypto.randomUUID(), startedAt: new Date().toISOString() }));
    const recovered = acquireReleaseLock(root);
    assert(fs.readdirSync(path.join(root, 'artifacts')).some(name => name.startsWith('release.lock.stale-')), 'dead same-host lock must be retained and safely recovered');
    releaseLock(recovered);
    git(['init', '--quiet']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'artifacts/\n');
    fs.mkdirSync(path.join(root, 'extensions', 'component'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', 'component', 'package.json'), JSON.stringify({ scripts: { 'package:host': 'node package.cjs' }, photoflowComponent: { manifest: 'component.json' } }));
    fs.writeFileSync(path.join(root, 'extensions', 'component', 'component.json'), JSON.stringify({ id: 'component', version: '1.0.0' }));
    git(['add', '.gitignore', 'extensions']);
    git(['-c', 'user.name=PhotoFlow Test', '-c', 'user.email=test@photoflow.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const componentIdentity = { id: 'component', version: '1.0.0', fileName: 'PhotoFlow-component-1.0.0-win32-x64.zip' };
    assert.throws(() => assertComponentBuildReceipt({ buildCommit: 'a'.repeat(40), archive: { fileName: componentIdentity.fileName }, component: { id: componentIdentity.id, version: componentIdentity.version } }, componentIdentity, commit), /固定 HEAD/);
    const staging = path.join(root, 'artifacts', 'releases', commit, '1.0.0'); fs.mkdirSync(staging, { recursive: true });
    const setupBytes = Buffer.from('setup'.repeat(16)); const componentBytes = Buffer.from('component'.repeat(16));
    fs.writeFileSync(path.join(staging, 'PhotoFlow Setup 1.0.0.exe'), setupBytes);
    fs.writeFileSync(path.join(staging, 'PhotoFlow-component-1.0.0-win32-x64.zip'), componentBytes);
    const artifacts = [
      { type: 'setup', fileName: 'PhotoFlow Setup 1.0.0.exe', size: setupBytes.length, sha256: digest(setupBytes) },
      { type: 'component', fileName: 'PhotoFlow-component-1.0.0-win32-x64.zip', componentId: 'component', version: '1.0.0', platform: 'win32', arch: 'x64', size: componentBytes.length, sha256: digest(componentBytes) },
    ];
    const first = JSON.stringify(createStableManifest({ product: 'Fixture', version: '1.0.0', buildSourceCommit: commit, buildSourceTree: tree, artifacts }));
    const second = JSON.stringify(createStableManifest({ product: 'Fixture', version: '1.0.0', buildSourceCommit: commit, buildSourceTree: tree, artifacts: [...artifacts].reverse() }));
    assert.equal(first, second, 'stable manifest must not depend on attempt time or artifact enumeration order');
    fs.writeFileSync(path.join(staging, 'DELIVERY-MANIFEST.json'), `${JSON.stringify(JSON.parse(first), null, 2)}\n`);
    const evidence = await verifyStagedRelease({ repositoryRoot: root, manifestPath: path.join(staging, 'DELIVERY-MANIFEST.json') });
    fs.writeFileSync(path.join(root, 'approval-index.txt'), 'approval commit after immutable build');
    git(['add', 'approval-index.txt']);
    git(['-c', 'user.name=PhotoFlow Test', '-c', 'user.email=test@photoflow.invalid', 'commit', '--quiet', '-m', 'approval']);
    assert.equal((await verifyStagedRelease({ repositoryRoot: root, manifestPath: evidence.manifestPath })).manifest.buildSourceCommit, commit, 'a later clean approval commit must not invalidate immutable build provenance');
    fs.writeFileSync(path.join(staging, artifacts[1].fileName), 'replacement');
    await assert.rejects(verifyStagedRelease({ repositoryRoot: root, manifestPath: evidence.manifestPath }), /哈希不匹配/);
    fs.writeFileSync(path.join(staging, artifacts[1].fileName), componentBytes);
    const arbitraryArtifacts = artifacts.map(item => item.type === 'component' ? { ...item, componentId: 'handwritten-other' } : item);
    fs.writeFileSync(path.join(staging, 'DELIVERY-MANIFEST.json'), `${JSON.stringify(createStableManifest({ product: 'Fixture', version: '1.0.0', buildSourceCommit: commit, buildSourceTree: tree, artifacts: arbitraryArtifacts }), null, 2)}\n`);
    await assert.rejects(verifyStagedRelease({ repositoryRoot: root, manifestPath: evidence.manifestPath }), /组件集合/);
    fs.writeFileSync(path.join(staging, 'DELIVERY-MANIFEST.json'), `${JSON.stringify(JSON.parse(first), null, 2)}\n`);
    const fenced = await verifyStagedRelease({ repositoryRoot: root, manifestPath: evidence.manifestPath });
    fs.writeFileSync(evidence.manifestPath, '{}');
    assert.throws(() => assertStagedReleaseUnchanged(fenced), /替换或修改/);
    console.log('Stable release staging determinism and replacement tests passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
