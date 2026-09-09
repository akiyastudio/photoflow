const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyStagedRelease, assertStagedReleaseUnchanged } = require('./release-staging.cjs');
const { acquireReleaseLock, releaseLock } = require('./release-lock.cjs');
const { privateOutputPath } = require('./project-output-paths.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const templatePath = path.join(repositoryRoot, 'docs', 'legal', 'RELEASE_APPROVAL_TEMPLATE.json');

const parseManifestArgument = values => {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--manifest') return String(values[index + 1] || '').trim();
    if (value.startsWith('--manifest=')) return value.slice('--manifest='.length).trim();
  }
  return '';
};

const writeJsonExclusiveAtomic = (target, value) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.linkSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
};

const run = async () => {
  const manifestArgument = parseManifestArgument(process.argv.slice(2));
  if (!manifestArgument) throw new Error('必须显式提供 --manifest <不可变 staging/DELIVERY-MANIFEST.json>');
  const lock = acquireReleaseLock(repositoryRoot);
  try {
    const evidence = await verifyStagedRelease({ repositoryRoot, manifestPath: path.resolve(manifestArgument) });
    const outputPath = privateOutputPath(repositoryRoot, 'audits', 'legal', 'RELEASE_APPROVAL.json');
    if (fs.existsSync(outputPath)) {
      throw new Error(`私有批准索引已存在；请先人工核验并归档旧记录，拒绝覆盖：${outputPath}`);
    }
    const draft = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    draft.releaseVersion = String(evidence.manifest.version);
    draft.buildSourceCommit = String(evidence.manifest.buildSourceCommit);
    draft.installerSha256 = String(evidence.setup.sha256);
    draft.deliveryManifestSha256 = String(evidence.manifestSha256);
    writeJsonExclusiveAtomic(outputPath, draft);
    assertStagedReleaseUnchanged(evidence);
    console.log(`\nPrivate release approval draft created: ${outputPath}`);
    console.log('Complete the approval roles, blocker evidence indexes, timestamps, and set status to approved only after real approval.');
    console.log(`Then run: npm run check:release:final -- --manifest "${evidence.manifestPath}"`);
  } finally {
    releaseLock(lock);
  }
};

if (require.main === module) run().catch(error => {
  console.error(`Release approval preparation failed: ${error.message || error}`);
  process.exitCode = 1;
});

module.exports = { parseManifestArgument, writeJsonExclusiveAtomic };
