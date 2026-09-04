const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyComponentPackageReceipt, expectedComponentPackages, hashStableArtifact, assertSourceIdentity } = require('./verify-component-packages.cjs');
const { validateQualityReceipt, assertCleanGitWorktree } = require('./release-quality-receipt.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const installerRoot = path.join(repositoryRoot, 'artifacts', 'installers');
const outputPath = path.join(installerRoot, 'DELIVERY-MANIFEST.json');

const findInstaller = version => {
  const explicitIndex = process.argv.indexOf('--installer');
  if (explicitIndex >= 0) return path.resolve(process.argv[explicitIndex + 1]);
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = fs.readdirSync(installerRoot).filter(name => new RegExp(`Setup\\s+${escaped}\\.exe$`, 'i').test(name));
  if (candidates.length !== 1) throw new Error(`需要且只能有一个 ${version} Setup EXE，实际找到 ${candidates.length} 个`);
  return path.join(installerRoot, candidates[0]);
};

const generateDeliveryManifest = async () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const version = String(packageJson.version);
  fs.mkdirSync(installerRoot, { recursive: true });
  fs.rmSync(outputPath, { force: true });
  const temporary = `${outputPath}.${crypto.randomUUID()}.tmp`;
  let completed = false;
  try {
    const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
    if (commitResult.error || commitResult.status !== 0) throw new Error('无法读取交付清单对应的 Git HEAD');
    const gitCommit = commitResult.stdout.trim();
    const qualityGate = validateQualityReceipt({ repositoryRoot, gitCommit });
    const sourceWorktree = assertCleanGitWorktree(repositoryRoot);
    const installerPath = findInstaller(version);
    const installer = await hashStableArtifact(installerPath);
    const sources = [{ path: qualityGate.sourcePath, identity: qualityGate.sourceIdentity }, { path: installerPath, identity: installer.identity }];
    const artifacts = [{ type: 'setup', fileName: path.basename(installerPath), size: installer.size, sha256: installer.sha256 }];
    const expectedComponents = expectedComponentPackages(installerRoot);
    const expectedNames = new Set(expectedComponents.map(component => component.fileName.toLowerCase()));
    const unexpected = fs.readdirSync(installerRoot, { withFileTypes: true }).filter(entry => entry.isFile() && /^PhotoFlow-.*\.zip$/i.test(entry.name) && !expectedNames.has(entry.name.toLowerCase())).map(entry => entry.name);
    if (unexpected.length) throw new Error(`交付目录包含当前发布集合之外的组件 ZIP，请先隔离：${unexpected.sort().join(', ')}`);
    for (const component of expectedComponents) {
      if (String(component.version) !== version) throw new Error(`组件版本与应用不一致：${component.id} ${component.version} != ${version}`);
      if (!fs.statSync(component.path, { throwIfNoEntry: false })?.isFile()) throw new Error(`组件交付物缺失：${component.fileName}`);
      const verified = await verifyComponentPackageReceipt(component.path, { ...component, platform: process.platform, arch: process.arch });
      sources.push({ path: component.path, identity: verified.sourceIdentity });
      sources.push({ path: verified.receiptPath, identity: verified.receiptIdentity });
      artifacts.push({ type: 'component', fileName: component.fileName, size: verified.size, sha256: verified.sha256, componentId: verified.componentId, version: verified.version, platform: verified.platform, arch: verified.arch, verificationReceipt: verified.verificationReceipt });
    }
    const manifest = { schemaVersion: 1, product: packageJson.productName || packageJson.name, version, gitCommit, sourceWorktree, qualityGate, artifacts };
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    for (const source of sources) assertSourceIdentity(source.path, source.identity);
    assertCleanGitWorktree(repositoryRoot);
    fs.renameSync(temporary, outputPath);
    if (process.platform !== 'win32') {
      const directoryFd = fs.openSync(installerRoot, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
    completed = true;
    console.log(`Delivery manifest: ${outputPath} (${artifacts.length} audited artifacts; no signature or approval asserted)`);
    return manifest;
  } finally {
    fs.rmSync(temporary, { force: true });
    if (!completed) fs.rmSync(outputPath, { force: true });
  }
};

if (require.main === module) generateDeliveryManifest().catch(error => { console.error(`Delivery manifest generation failed: ${error.message || error}`); process.exitCode = 1; });

module.exports = { generateDeliveryManifest };
