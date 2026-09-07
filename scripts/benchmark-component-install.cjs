const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const archive = require('../electron/component-package-archive.cjs');
const { copyComponentIntoStaging } = require('../electron/modules/system-ipc.cjs');
const { privateOutputPath } = require('./project-output-paths.cjs');
(async () => {
  const parent = privateOutputPath(path.resolve(__dirname, '..'), 'diagnostics');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'install-benchmark-'));
  const timings = {};
  const measure = async (name, action) => { const start = performance.now(); const result = await action(); timings[name] = Math.round(performance.now() - start); return result; };
  const source = path.resolve(process.argv[2]);
  const snapshot = path.join(root, 'snapshot.zip');
  const receipt = await measure('snapshotMs', () => archive.snapshotComponentArchive(source, snapshot));
  const inspection = archive.inspectComponentArchive(snapshot, { inspectionToken: receipt.inspectionToken });
  const extracted = path.join(root, 'extracted');
  const result = await measure('extractMs', () => archive.extractComponentArchive(inspection, extracted));
  const componentRoot = path.resolve(extracted, path.dirname(result.manifestEntry));
  const identity = archive.componentSubtreeIdentity(result.treeIdentity, result.manifestEntry);
  if (process.argv.includes('--legacy-scans')) await measure('redundantScansMs', async () => {
    await archive.verifyComponentTreeIdentity(componentRoot, identity, { includeNode: true });
    await archive.verifyComponentTreeIdentity(componentRoot, identity, { includeNode: true });
  });
  const staging = path.join(root, 'staging'); fs.mkdirSync(staging);
  await measure('copyAndVerifyMs', async () => {
    await copyComponentIntoStaging(fs, path, componentRoot, staging);
    await archive.captureVerifiedComponentTreeIdentity(staging, identity);
  });
  timings.totalMs = Object.values(timings).reduce((a, b) => a + b, 0);
  fs.writeFileSync(path.join(root, 'timings.json'), JSON.stringify({ source, timings }, null, 2));
  console.log(JSON.stringify(timings));
})().catch(error => { console.error(error); process.exitCode = 1; });
