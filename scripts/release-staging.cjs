const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { expectedComponentPackages, receiptPathFor, hashStableArtifact, captureArtifactIdentity, assertSourceIdentity } = require('./verify-component-packages.cjs');
const { readGitHead, assertGitHead, assertCleanGitWorktree } = require('./release-quality-receipt.cjs');

const copyStable = async (source, target) => {
  const identity = captureArtifactIdentity(source);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const input = fs.createReadStream(source);
  const inspect = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
  const output = fs.createWriteStream(target, { flags: 'wx' });
  await pipeline(input, inspect, output);
  assertSourceIdentity(source, identity);
  const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { size, sha256: hash.digest('hex') };
};
const assertComponentBuildReceipt = (receipt, component, gitCommit) => {
  const rootKeys = ['schemaVersion', 'verifierVersion', 'command', 'status', 'verifiedAt', 'buildCommit', 'archive', 'component'];
  const archiveKeys = ['fileName', 'size', 'sha256']; const componentKeys = ['id', 'version', 'platform', 'arch'];
  if (!receipt || Object.keys(receipt).sort().join('\0') !== rootKeys.sort().join('\0') || Object.keys(receipt.archive || {}).sort().join('\0') !== archiveKeys.sort().join('\0') || Object.keys(receipt.component || {}).sort().join('\0') !== componentKeys.sort().join('\0')
    || receipt.schemaVersion !== 1 || receipt.verifierVersion !== 1 || receipt.command !== 'npm run verify:component-packages' || receipt.status !== 'passed' || !Number.isFinite(Date.parse(receipt.verifiedAt))
    || receipt.buildCommit !== gitCommit || receipt.archive.fileName !== component.fileName || !Number.isSafeInteger(receipt.archive.size) || !/^[a-f0-9]{64}$/.test(receipt.archive.sha256)
    || receipt.component.id !== component.id || String(receipt.component.version) !== String(component.version) || receipt.component.platform !== process.platform || receipt.component.arch !== process.arch) throw new Error(`组件构建回执不属于固定 HEAD：${component.id}`);
  return true;
};
const createStableManifest = ({ product, version, buildSourceCommit, buildSourceTree, artifacts }) => ({ schemaVersion: 2, product, version, buildSourceCommit, buildSourceTree, artifacts: [...artifacts].sort((a, b) => a.fileName.localeCompare(b.fileName, 'en')) });
const stageRelease = async ({ repositoryRoot, installerRoot, product, version, gitCommit, gitTree }) => {
  assertGitHead(repositoryRoot, gitCommit); assertCleanGitWorktree(repositoryRoot);
  const finalRoot = path.join(repositoryRoot, 'artifacts', 'releases', gitCommit, version);
  if (fs.existsSync(finalRoot)) throw new Error(`不可变发布 staging 已存在：${finalRoot}`);
  const temporary = `${finalRoot}.tmp-${crypto.randomUUID()}`;
  fs.mkdirSync(temporary, { recursive: true });
  try {
    const setupPattern = new RegExp(`Setup\\s+${String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.exe$`, 'i');
    const setups = fs.readdirSync(installerRoot).filter(name => setupPattern.test(name));
    if (setups.length !== 1) throw new Error(`需要且只能有一个 ${version} Setup EXE`);
    const expected = expectedComponentPackages(installerRoot);
    const expectedNames = new Set(expected.map(item => item.fileName.toLowerCase()));
    const extra = fs.readdirSync(installerRoot).filter(name => /^PhotoFlow-.*\.zip$/i.test(name) && !expectedNames.has(name.toLowerCase()));
    if (extra.length) throw new Error(`交付目录包含额外组件 ZIP：${extra.join(', ')}`);
    const artifacts = [];
    const setupSource = path.join(installerRoot, setups[0]);
    artifacts.push({ type: 'setup', fileName: setups[0], ...await copyStable(setupSource, path.join(temporary, setups[0])) });
    for (const component of expected) {
      const receipt = JSON.parse(fs.readFileSync(receiptPathFor(component.path), 'utf8'));
      assertComponentBuildReceipt(receipt, component, gitCommit);
      const copied = await copyStable(component.path, path.join(temporary, component.fileName));
      if (copied.size !== receipt.archive.size || copied.sha256 !== receipt.archive.sha256) throw new Error(`组件构建后字节已变化：${component.id}`);
      artifacts.push({ type: 'component', fileName: component.fileName, componentId: component.id, version: component.version, platform: process.platform, arch: process.arch, ...copied });
    }
    assertGitHead(repositoryRoot, gitCommit); assertCleanGitWorktree(repositoryRoot);
    const manifest = createStableManifest({ product, version, buildSourceCommit: gitCommit, buildSourceTree: gitTree, artifacts });
    fs.writeFileSync(path.join(temporary, 'DELIVERY-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    for (const name of fs.readdirSync(temporary)) fs.chmodSync(path.join(temporary, name), 0o444);
    fs.chmodSync(temporary, 0o555);
    fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
    fs.renameSync(temporary, finalRoot);
    return { root: finalRoot, manifestPath: path.join(finalRoot, 'DELIVERY-MANIFEST.json'), manifest };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
};
const verifyStagedRelease = async ({ repositoryRoot, manifestPath }) => {
  const absoluteManifest = path.resolve(manifestPath);
  const root = path.dirname(absoluteManifest);
  const manifestDigest = await hashStableArtifact(absoluteManifest);
  const manifestIdentity = manifestDigest.identity;
  const manifestBytes = fs.readFileSync(absoluteManifest);
  assertSourceIdentity(absoluteManifest, manifestIdentity);
  const manifestSha256 = manifestDigest.sha256;
  const manifest = JSON.parse(manifestBytes);
  const commit = String(manifest.buildSourceCommit || '');
  const treeResult = require('node:child_process').spawnSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  if (manifest.schemaVersion !== 2 || !/^[a-f0-9]{40}$/i.test(commit) || treeResult.error || treeResult.status !== 0 || treeResult.stdout.trim() !== manifest.buildSourceTree) throw new Error('交付清单构建源码 commit/tree 不可验证');
  const canonicalRoot = path.join(repositoryRoot, 'artifacts', 'releases', commit, String(manifest.version));
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 2 || manifest.artifacts.length > 64 || path.resolve(root) !== path.resolve(canonicalRoot)) throw new Error('交付清单集合或 staging 路径无效');
  const names = new Set();
  for (const artifact of manifest.artifacts) {
    const allowedKeys = artifact?.type === 'setup' ? ['type', 'fileName', 'size', 'sha256'] : ['type', 'fileName', 'componentId', 'version', 'platform', 'arch', 'size', 'sha256'];
    if (!artifact || !['setup', 'component'].includes(artifact.type) || Object.keys(artifact).sort().join('\0') !== allowedKeys.sort().join('\0') || path.basename(artifact.fileName) !== artifact.fileName || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('交付清单 artifact 结构无效');
    const folded = artifact.fileName.toLowerCase(); if (names.has(folded)) throw new Error('交付清单包含重复 artifact'); names.add(folded);
  }
  const canonical = `${JSON.stringify(createStableManifest(manifest), null, 2)}\n`;
  if (!manifestBytes.equals(Buffer.from(canonical))) throw new Error('交付清单不是确定性 canonical 表示');
  assertCleanGitWorktree(repositoryRoot);
  const allowed = new Set(['DELIVERY-MANIFEST.json', ...manifest.artifacts.map(item => item.fileName)]);
  const actual = fs.readdirSync(root, { withFileTypes: true });
  if (actual.some(entry => !entry.isFile() || !allowed.has(entry.name)) || actual.length !== allowed.size) throw new Error('不可变 staging 文件集合与交付清单不一致');
  let setup = null;
  const identities = [{ path: absoluteManifest, identity: manifestIdentity }];
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(root, artifact.fileName);
    const digest = await hashStableArtifact(artifactPath);
    if (digest.size !== artifact.size || digest.sha256 !== artifact.sha256) throw new Error(`staging 交付物哈希不匹配：${artifact.fileName}`);
    identities.push({ path: artifactPath, identity: digest.identity });
    if (artifact.type === 'setup') setup = { ...artifact, path: artifactPath };
  }
  if (!setup) throw new Error('交付清单缺少 Setup');
  const componentArtifacts = manifest.artifacts.filter(item => item.type === 'component');
  const sourceComponents = expectedComponentsAtCommit(repositoryRoot, commit);
  if (JSON.stringify(componentArtifacts.map(item => ({ id: item.componentId, version: String(item.version), platform: item.platform, arch: item.arch })).sort((a, b) => a.id.localeCompare(b.id))) !== JSON.stringify(sourceComponents)) throw new Error('交付清单组件集合与构建源码提交不一致');
  if (manifest.artifacts.filter(item => item.type === 'setup').length !== 1) throw new Error('交付清单必须且只能包含一个 Setup');
  assertSourceIdentity(absoluteManifest, manifestIdentity);
  return { root, manifestPath: absoluteManifest, manifestSha256, manifest, setup, identities };
};
const assertStagedReleaseUnchanged = evidence => { for (const item of evidence.identities) assertSourceIdentity(item.path, item.identity); };

const gitShowJson = (repositoryRoot, commit, file) => {
  const result = require('node:child_process').spawnSync('git', ['show', `${commit}:${file}`], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`构建源码缺少组件元数据：${file}`);
  return JSON.parse(result.stdout);
};
function expectedComponentsAtCommit(repositoryRoot, commit) {
  const listed = require('node:child_process').spawnSync('git', ['ls-tree', '--name-only', `${commit}:extensions`], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  if (listed.error || listed.status !== 0) throw new Error('无法读取构建提交的组件集合');
  return listed.stdout.split(/\r?\n/).filter(Boolean).flatMap(directory => {
    let packageJson;
    try { packageJson = gitShowJson(repositoryRoot, commit, `extensions/${directory}/package.json`); } catch { return []; }
    if (!packageJson.photoflowComponent || !packageJson.scripts?.['package:host']) return [];
    const component = gitShowJson(repositoryRoot, commit, `extensions/${directory}/${packageJson.photoflowComponent.manifest}`);
    return [{ id: String(component.id), version: String(component.version), platform: process.platform, arch: process.arch }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { copyStable, assertComponentBuildReceipt, createStableManifest, expectedComponentsAtCommit, stageRelease, verifyStagedRelease, assertStagedReleaseUnchanged };
