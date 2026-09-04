const path = require('node:path');
const { verifyStagedRelease } = require('./release-staging.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const manifestIndex = process.argv.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? path.resolve(process.argv[manifestIndex + 1] || '') : '';

const run = async () => {
  if (!manifestPath) throw new Error('稳定交付清单只能由 release:prepare 在锁定 session 中生成；验证时请提供 --manifest <staging/DELIVERY-MANIFEST.json>');
  const evidence = await verifyStagedRelease({ repositoryRoot, manifestPath });
  console.log(`Stable delivery manifest verified: ${evidence.manifestPath} (${evidence.manifest.artifacts.length} artifacts, sha256 ${evidence.manifestSha256})`);
};

if (require.main === module) run().catch(error => { console.error(`Delivery manifest verification failed: ${error.message || error}`); process.exitCode = 1; });

module.exports = { run };
