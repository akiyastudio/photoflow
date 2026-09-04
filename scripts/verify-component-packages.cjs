const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createComponentRegistry } = require('../electron/component-registry.cjs');
const { MAX_ARCHIVE_BYTES, extractComponentArchive, inspectComponentArchive, snapshotComponentArchive } = require('../electron/component-package-archive.cjs');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');
const { validateComponentIntegrity } = require('../electron/component-integrity.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const defaultPackageRoot = path.join(repositoryRoot, 'artifacts', 'installers');
const MAX_INTEGRITY_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const RECEIPT_SCHEMA_VERSION = 1;
const VERIFIER_VERSION = 1;
const COMPONENT_ARCHIVE = /^PhotoFlow-(.+)-(win32|darwin|linux)-(x64|arm64|ia32)\.zip$/;
const identityFor = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameIdentity = (left, right) => left && right && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);
const assertSourceIdentity = (archivePath, expected) => {
  const current = fs.statSync(archivePath, { throwIfNoEntry: false });
  if (!current?.isFile() || !sameIdentity(expected, identityFor(current))) throw new Error(`组件包在验证期间被替换或修改：${archivePath}`);
};
const captureArtifactIdentity = artifactPath => {
  const stat = fs.statSync(artifactPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || !Number.isSafeInteger(stat.size)) throw new Error(`交付物不存在或不是普通文件：${artifactPath}`);
  return identityFor(stat);
};
const hashStableArtifact = async archivePath => {
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES) throw new Error(`交付物本体大小超过安全上限：${archivePath}`);
    const identity = identityFor(stat);
    assertSourceIdentity(archivePath, identity);
    const hash = crypto.createHash('sha256');
    await pipeline(handle.createReadStream({ autoClose: false }), new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(); } }));
    if (!sameIdentity(identity, identityFor(await handle.stat()))) throw new Error(`组件包在哈希期间被修改：${archivePath}`);
    assertSourceIdentity(archivePath, identity);
    return { size: stat.size, sha256: hash.digest('hex'), identity };
  } finally { await handle.close(); }
};
const expectedComponentPackages = (packageRoot, platform = process.platform, arch = process.arch) => {
  const seenIds = new Set();
  return fs.readdirSync(path.join(repositoryRoot, 'extensions'), { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const packagePath = path.join(repositoryRoot, 'extensions', entry.name, 'package.json');
    if (!fs.existsSync(packagePath)) return [];
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (!packageJson.photoflowComponent || !packageJson.scripts?.['package:host']) return [];
    const manifestPath = path.join(path.dirname(packagePath), String(packageJson.photoflowComponent.manifest || ''));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const id = String(manifest.id || '');
    if (!id || seenIds.has(id)) throw new Error(`组件发布集合包含重复或无效 ID：${id || entry.name}`);
    seenIds.add(id);
    const fileName = `PhotoFlow-${id}-${manifest.version}-${platform}-${arch}.zip`;
    return [{ id, version: String(manifest.version || ''), fileName, path: path.join(packageRoot, fileName) }];
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
};

const verifyComponentPackage = async archivePath => {
  const absoluteArchive = path.resolve(archivePath);
  const fileName = path.basename(absoluteArchive);
  const nameMatch = COMPONENT_ARCHIVE.exec(fileName);
  if (!nameMatch) throw new Error(`组件包文件名无效：${fileName}`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-verify-'));
  try {
    const isolatedPackageRoot = path.join(temporaryRoot, 'packages');
    fs.mkdirSync(isolatedPackageRoot);
    const isolatedArchive = path.join(isolatedPackageRoot, fileName);
    const sourceSnapshot = await snapshotComponentArchive(absoluteArchive, isolatedArchive);
    const packageInspection = inspectComponentArchive(isolatedArchive, { inspectionToken: sourceSnapshot.inspectionToken });
    const { archive } = packageInspection;
    const manifest = packageInspection.manifest;
    const platform = nameMatch[2];
    const arch = nameMatch[3];
    const expectedName = `PhotoFlow-${manifest.id}-${manifest.version}-${platform}-${arch}.zip`;
    if (fileName !== expectedName) throw new Error(`组件包文件名身份不匹配：需要 ${expectedName}`);
    if (!Array.isArray(manifest.platforms) || !manifest.platforms.includes(platform)) throw new Error(`组件清单平台与文件名不匹配：${platform}`);
    if (!Array.isArray(manifest.architectures) || !manifest.architectures.includes(arch)) throw new Error(`组件清单架构与文件名不匹配：${arch}`);
    const extractedRoot = path.join(temporaryRoot, 'extracted');
    await extractComponentArchive(packageInspection, extractedRoot);
    const manifestRoot = path.dirname(path.join(extractedRoot, ...packageInspection.manifestEntry.split('/')));
    parseComponentHostManifest(manifest, manifestRoot);
    const registry = createComponentRegistry({ projectRoot: repositoryRoot, userComponentRoot: isolatedPackageRoot, isPackaged: true, platform, arch });
    const resolved = registry.resolvePackage(manifest.id);
    if (path.resolve(resolved.packagePath) !== isolatedArchive) throw new Error(`组件注册表未接受当前包：${fileName}`);
    if (manifest.integrity !== undefined) {
      if (manifest.integrity !== 'component-integrity.json') throw new Error('组件完整性清单必须为 component-integrity.json');
      const integrityPath = path.join(manifestRoot, manifest.integrity);
      const stat = fs.statSync(integrityPath, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size > MAX_INTEGRITY_BYTES) throw new Error('组件完整性清单缺失或过大');
      const integrity = JSON.parse(fs.readFileSync(integrityPath, 'utf8'));
      if (String(integrity.componentId) !== String(manifest.id) || String(integrity.version) !== String(manifest.version)) throw new Error('组件完整性清单身份与 component.json 不一致');
      validateComponentIntegrity(manifestRoot, integrity);
    }
    assertSourceIdentity(absoluteArchive, sourceSnapshot);
    return { fileName, size: archive.size, sha256: sourceSnapshot.sha256, componentId: manifest.id, version: manifest.version, platform, arch, sourceIdentity: sourceSnapshot };
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
};

const receiptPathFor = archivePath => `${path.resolve(archivePath)}.verification.json`;
const writeVerificationReceipt = (archivePath, result) => {
  const receiptPath = receiptPathFor(archivePath);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    verifierVersion: VERIFIER_VERSION,
    command: 'npm run verify:component-packages',
    status: 'passed',
    verifiedAt: new Date().toISOString(),
    buildCommit: String(result.buildCommit || ''),
    archive: { fileName: result.fileName, size: result.size, sha256: result.sha256 },
    component: { id: result.componentId, version: result.version, platform: result.platform, arch: result.arch },
  };
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, receiptPath);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  return receiptPath;
};
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(`组件验证回执 ${label} 结构无效`);
};
const verifyComponentPackageReceipt = async (archivePath, expected) => {
  const absoluteArchive = path.resolve(archivePath);
  const verified = await verifyComponentPackage(absoluteArchive);
  const receiptPath = receiptPathFor(absoluteArchive);
  let receiptFd;
  try { receiptFd = fs.openSync(receiptPath, 'r'); }
  catch (error) { if (error?.code === 'ENOENT') throw new Error(`组件验证回执缺失或过大：${path.basename(receiptPath)}`); throw error; }
  let receiptIdentity;
  let receipt;
  try {
    const receiptStat = fs.fstatSync(receiptFd);
    if (!receiptStat.isFile() || receiptStat.size < 2 || receiptStat.size > MAX_RECEIPT_BYTES) throw new Error(`组件验证回执缺失或过大：${path.basename(receiptPath)}`);
    receiptIdentity = identityFor(receiptStat);
    assertSourceIdentity(receiptPath, receiptIdentity);
    receipt = JSON.parse(fs.readFileSync(receiptFd, 'utf8'));
    if (!sameIdentity(receiptIdentity, identityFor(fs.fstatSync(receiptFd)))) throw new Error(`组件验证回执在读取期间被修改：${path.basename(receiptPath)}`);
    assertSourceIdentity(receiptPath, receiptIdentity);
  } finally { fs.closeSync(receiptFd); }
  exactKeys(receipt, ['schemaVersion', 'verifierVersion', 'command', 'status', 'verifiedAt', 'buildCommit', 'archive', 'component'], '根对象');
  exactKeys(receipt.archive, ['fileName', 'size', 'sha256'], 'archive');
  exactKeys(receipt.component, ['id', 'version', 'platform', 'arch'], 'component');
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || receipt.verifierVersion !== VERIFIER_VERSION || receipt.command !== 'npm run verify:component-packages' || receipt.status !== 'passed' || !Number.isFinite(Date.parse(receipt.verifiedAt)) || !/^[a-f0-9]{40}$/i.test(receipt.buildCommit)) throw new Error('组件验证回执版本或执行证据无效，必须重新完整验证');
  const expectedIdentity = { id: String(expected.id), version: String(expected.version), platform: String(expected.platform), arch: String(expected.arch) };
  if (JSON.stringify(receipt.component) !== JSON.stringify(expectedIdentity)) throw new Error(`组件验证回执身份与当前发布集合不一致：${path.basename(absoluteArchive)}`);
  if (receipt.archive.fileName !== path.basename(absoluteArchive) || !Number.isSafeInteger(receipt.archive.size) || !/^[a-f0-9]{64}$/.test(receipt.archive.sha256)) throw new Error('组件验证回执 archive 字段无效');
  if (verified.fileName !== receipt.archive.fileName || verified.size !== receipt.archive.size || verified.sha256 !== receipt.archive.sha256
    || verified.componentId !== receipt.component.id || String(verified.version) !== receipt.component.version || verified.platform !== receipt.component.platform || verified.arch !== receipt.component.arch) throw new Error(`组件 ZIP 与审计回执不一致：${path.basename(absoluteArchive)}`);
  return { ...verified, receiptPath, receiptIdentity, verificationReceipt: { schemaVersion: receipt.schemaVersion, verifierVersion: receipt.verifierVersion, command: receipt.command, status: receipt.status, verifiedAt: receipt.verifiedAt, buildCommit: receipt.buildCommit, trust: 'informational' } };
};

const parseArguments = values => {
  const result = { packageRoot: defaultPackageRoot, paths: [], writeReceipts: false, buildCommit: '' };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--write-receipts') result.writeReceipts = true;
    else if (value === '--build-commit') {
      const commit = values[++index];
      if (!/^[a-f0-9]{40}$/i.test(String(commit || ''))) throw new Error('--build-commit 需要完整 Git SHA');
      result.buildCommit = commit;
    }
    else if (value === '--package-root') {
      const directory = values[++index];
      if (!directory || directory.startsWith('--')) throw new Error('--package-root 需要目录参数');
      result.packageRoot = path.resolve(directory);
    } else if (value.startsWith('--package-root=')) {
      const directory = value.slice('--package-root='.length);
      if (!directory) throw new Error('--package-root 需要目录参数');
      result.packageRoot = path.resolve(directory);
    } else if (value.startsWith('--')) throw new Error(`未知参数：${value}`);
    else result.paths.push(path.resolve(value));
  }
  return result;
};

const run = async () => {
  const { packageRoot, paths, writeReceipts, buildCommit } = parseArguments(process.argv.slice(2));
  const expected = paths.length ? [] : expectedComponentPackages(packageRoot);
  const packages = paths.length ? paths : expected.map(component => {
    if (!fs.statSync(component.path, { throwIfNoEntry: false })?.isFile()) throw new Error(`组件包缺失：${component.fileName}`);
    return component.path;
  });
  const results = [];
  for (const packagePath of packages) {
    const verified = await verifyComponentPackage(packagePath);
    results.push(verified);
    console.log(`Verified component package: ${verified.fileName} (${verified.size} bytes, sha256 ${verified.sha256})`);
    if (writeReceipts) {
      if (!buildCommit) throw new Error('--write-receipts 必须同时提供 --build-commit');
      console.log(`Verification receipt: ${writeVerificationReceipt(packagePath, { ...verified, buildCommit })}`);
    }
  }
  return results;
};

if (require.main === module) run().catch(error => { console.error(`Component package verification failed: ${error.message || error}`); process.exitCode = 1; });

module.exports = { verifyComponentPackage, verifyComponentPackageReceipt, writeVerificationReceipt, expectedComponentPackages, parseArguments, receiptPathFor, hashStableArtifact, captureArtifactIdentity, assertSourceIdentity };
