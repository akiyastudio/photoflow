const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { verifyComponentPackage, expectedComponentPackages } = require('./verify-component-packages.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const installerRoot = path.join(repositoryRoot, 'artifacts', 'installers');
const outputPath = path.join(installerRoot, 'DELIVERY-MANIFEST.json');

const digestFile = async filePath => {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(); } }));
  return hash.digest('hex');
};

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
  const installerPath = findInstaller(version);
  const installerStat = fs.statSync(installerPath, { throwIfNoEntry: false });
  if (!installerStat?.isFile()) throw new Error(`Setup EXE 不存在：${installerPath}`);
  const artifacts = [{ type: 'setup', fileName: path.basename(installerPath), size: installerStat.size, sha256: await digestFile(installerPath) }];
  for (const component of expectedComponentPackages(installerRoot)) {
    if (String(component.version) !== version) throw new Error(`组件版本与应用不一致：${component.id} ${component.version} != ${version}`);
    if (!fs.statSync(component.path, { throwIfNoEntry: false })?.isFile()) throw new Error(`组件交付物缺失：${component.fileName}`);
    const verified = await verifyComponentPackage(component.path);
    artifacts.push({ type: 'component', fileName: component.fileName, size: verified.size, sha256: verified.sha256, componentId: verified.componentId, version: verified.version, platform: verified.platform, arch: verified.arch });
  }
  const manifest = { schemaVersion: 1, product: packageJson.productName || packageJson.name, version, artifacts };
  fs.mkdirSync(installerRoot, { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, outputPath);
  console.log(`Delivery manifest: ${outputPath} (${artifacts.length} audited artifacts; no signature or approval asserted)`);
  return manifest;
};

if (require.main === module) generateDeliveryManifest().catch(error => { console.error(`Delivery manifest generation failed: ${error.message || error}`); process.exitCode = 1; });

module.exports = { generateDeliveryManifest };
