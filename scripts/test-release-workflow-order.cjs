const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PREPARE_STEPS } = require('./prepare-release.cjs');
const { writeQualityReceipt, validateQualityReceipt, assertCleanGitWorktree } = require('./release-quality-receipt.cjs');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.deepEqual(PREPARE_STEPS, ['check:release:quality', 'electron:build', 'build:components', 'release:manifest']);
assert.equal(packageJson.scripts['release:prepare'], 'node scripts/prepare-release.cjs');
assert.equal(packageJson.scripts['check:release:quality'], 'node scripts/check-project.cjs --release-quality');
assert.equal(packageJson.scripts['check:release:final'], 'node scripts/check-final-release-ready.cjs');
const finalSource = fs.readFileSync(path.join(root, 'scripts', 'check-final-release-ready.cjs'), 'utf8');
assert(finalSource.indexOf('test-legal-release-evidence.cjs') < finalSource.indexOf('generate-delivery-manifest.cjs'), 'final approval must be checked before regenerating delivery metadata');
const publishSource = fs.readFileSync(path.join(root, 'scripts', 'publish-release.cjs'), 'utf8');
assert(publishSource.indexOf('runLegalReleaseReadyGate(installerPath)') < publishSource.indexOf('generate-delivery-manifest.cjs'), 'publish must recheck approval before delivery metadata');
assert(publishSource.indexOf('generate-delivery-manifest.cjs') < publishSource.indexOf('let token = String(process.env.PHOTOFLOW_ADMIN_TOKEN'), 'publish must validate all artifacts before reading a token or using the network');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-release-receipt-'));
try {
  const git = args => { const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(fixtureRoot, 'component.json'), '{}');
  fs.writeFileSync(path.join(fixtureRoot, '.gitignore'), 'artifacts/\n');
  git(['add', 'component.json', '.gitignore']);
  git(['-c', 'user.name=PhotoFlow Test', '-c', 'user.email=test@photoflow.invalid', 'commit', '--quiet', '-m', 'fixture']);
  assert.equal(assertCleanGitWorktree(fixtureRoot).status, 'clean');
  const quality = writeQualityReceipt({ repositoryRoot: fixtureRoot, gitCommit: 'a'.repeat(40), startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z' });
  assert.equal(validateQualityReceipt({ repositoryRoot: fixtureRoot, gitCommit: 'a'.repeat(40) }).status, 'passed');
  assert.equal(quality.command, 'npm run check:release:quality');
  fs.writeFileSync(path.join(fixtureRoot, 'component.json'), '{"dirty":true}');
  assert.throws(() => assertCleanGitWorktree(fixtureRoot), /未提交|构建输入/);
  git(['checkout', '--', 'component.json']);
  assert.throws(() => validateQualityReceipt({ repositoryRoot: fixtureRoot, gitCommit: 'b'.repeat(40) }), /不对应当前 HEAD/);
} finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
console.log('Release workflow ordering tests passed.');
