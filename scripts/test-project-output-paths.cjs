const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installersRootFor, privateRootFor, privateOutputPath, releaseOperationsRoot } = require('./project-output-paths.cjs');
const { acquireReleaseLock, releaseLock } = require('./release-lock.cjs');
const { clearCurrentReleaseOutputs } = require('./prepare-release.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-output-policy-'));
const repository = path.join(temporary, 'source');
const privateRoot = path.join(temporary, 'private');
const previous = process.env.PHOTOFLOW_PRIVATE_ROOT;
try {
  fs.mkdirSync(repository);
  delete process.env.PHOTOFLOW_PRIVATE_ROOT;
  assert.throws(() => privateRootFor(repository), /Configure an absolute/);
  fs.writeFileSync(path.join(repository, '.photoflow-paths.local.json'), JSON.stringify({ privateRoot }));
  assert.equal(privateRootFor(repository), privateRoot);
  assert.equal(privateOutputPath(repository, 'audits', 'run.json'), path.join(privateRoot, 'audits', 'run.json'));
  assert.throws(() => privateOutputPath(repository, '..', 'escaped.json'), /escaped/);
  assert.throws(() => privateRootFor(repository, { PHOTOFLOW_PRIVATE_ROOT: path.join(repository, 'private') }), /outside/);
  fs.mkdirSync(privateRoot);
  fs.symlinkSync(repository, path.join(privateRoot, 'back-to-source'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => privateRootFor(repository, { PHOTOFLOW_PRIVATE_ROOT: path.join(privateRoot, 'back-to-source') }), /outside/);
  assert.throws(() => privateOutputPath(repository, 'back-to-source', 'leak.json'), /escaped/);
  fs.unlinkSync(path.join(privateRoot, 'back-to-source'));

  fs.mkdirSync(path.join(repository, 'artifacts'));
  const legacy = path.join(repository, 'artifacts', 'release.lock');
  fs.writeFileSync(legacy, '{}');
  assert.throws(() => acquireReleaseLock(repository), /Legacy release state/);
  assert(fs.existsSync(legacy), 'old locks must not be discarded during migration');
  fs.rmSync(legacy);
  const attempts = path.join(repository, 'artifacts', 'release-publish-attempts');
  fs.mkdirSync(attempts); fs.writeFileSync(path.join(attempts, 'pending.json'), '{}');
  assert.throws(() => acquireReleaseLock(repository), /Legacy release state/);
  fs.rmSync(attempts, { recursive: true });
  const lock = acquireReleaseLock(repository);
  assert.equal(lock.lockPath, path.join(releaseOperationsRoot(repository), 'release.lock'));
  assert.throws(() => acquireReleaseLock(repository), /正在运行/);
  releaseLock(lock);

  const installers = installersRootFor(repository);
  assert.equal(installers, path.join(repository, 'artifacts', 'installers'));
  const archived = path.join(installers, 'releases', 'commit', '1.0.0');
  fs.mkdirSync(archived, { recursive: true });
  fs.writeFileSync(path.join(archived, 'DELIVERY-MANIFEST.json'), 'immutable');
  fs.writeFileSync(path.join(installers, 'PhotoFlow Setup 1.0.0.exe'), 'old current installer');
  clearCurrentReleaseOutputs(installers, '1.0.0');
  assert.equal(fs.readFileSync(path.join(archived, 'DELIVERY-MANIFEST.json'), 'utf8'), 'immutable');
  assert(!fs.existsSync(path.join(installers, 'PhotoFlow Setup 1.0.0.exe')));

  const componentPaths = require('../extensions/team-retouch/scripts/package-output-paths.cjs');
  const projectInstallers = installersRootFor(path.resolve(__dirname, '..'));
  assert.equal(componentPaths.baseOutputRoot, projectInstallers);
  for (const value of [componentPaths.advancedOutputRoot, componentPaths.candidateRoot, componentPaths.advancedPackagePath('runtime.zip')]) {
    assert(path.relative(projectInstallers, value) && !path.relative(projectInstallers, value).startsWith('..'));
  }
  const host = require('../extensions/team-retouch/scripts/package-host.cjs');
  assert.equal(host.packagePath, componentPaths.advancedPackagePath(host.packageName));
  console.log('Project output routing, private path isolation, legacy state protection and immutable delivery preservation passed');
} finally {
  if (previous === undefined) delete process.env.PHOTOFLOW_PRIVATE_ROOT; else process.env.PHOTOFLOW_PRIVATE_ROOT = previous;
  fs.rmSync(temporary, { recursive: true, force: true });
}
