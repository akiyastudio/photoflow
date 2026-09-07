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
  const componentId = inspection.manifest.id;
  const staging = path.join(root, `.${componentId}-install-benchmark`); fs.mkdirSync(staging);
  let stagedIdentity;
  await measure('copyAndVerifyMs', async () => {
    await copyComponentIntoStaging(fs, path, componentRoot, staging);
    stagedIdentity = await archive.captureVerifiedComponentTreeIdentity(staging, identity);
  });
  if (process.argv.includes('--transactions')) {
    const { createComponentTransactionService, nodeIdentity } = require('../electron/services/component-transaction-service.cjs');
    const service = createComponentTransactionService({ fs, path, crypto: require('node:crypto'), installRoot: root, captureTreeIdentity: archive.captureComponentTreeIdentity, verifyTreeIdentity: archive.verifyComponentTreeIdentity, cleanupOwnedPath: archive.cleanupOwnedComponentPath });
    const container = path.join(root, componentId); fs.mkdirSync(container);
    const destination = path.join(container, 'runtime');
    await measure('preparationCleanupMs', async () => {
      await archive.cleanupOwnedComponentPath({ path: extracted, kind: 'directory', nodeIdentity: nodeIdentity(fs.statSync(extracted)), treeIdentity: result.treeIdentity }, { root });
      const stat = fs.statSync(snapshot);
      await archive.cleanupOwnedComponentPath({ path: snapshot, kind: 'file', nodeIdentity: nodeIdentity(stat), size: stat.size, mode: stat.mode & 0o777, sha256: receipt.sha256 }, { root });
    });
    await measure('installTransactionMs', () => service.install({ componentId, container, destination, stagingPath: staging, stagingIdentity: nodeIdentity(fs.statSync(staging)), stagingTreeIdentity: stagedIdentity, previousInstalled: false, desiredEnabled: true, validatePublished: async () => {}, commitHostState: async () => {} }));
    await measure('uninstallMs', async () => service.uninstall({ componentId, container, destination, targetPath: destination, targetIdentity: nodeIdentity(fs.statSync(destination)), targetTreeIdentity: await archive.captureComponentTreeIdentity(destination), clearUserData: false }));
  }
  timings.totalMs = Object.values(timings).reduce((a, b) => a + b, 0);
  fs.writeFileSync(path.join(root, 'timings.json'), JSON.stringify({ source, timings }, null, 2));
  console.log(JSON.stringify(timings));
})().catch(error => { console.error(error); process.exitCode = 1; });
