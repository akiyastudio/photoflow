const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extensions');
const outputRoot = path.join(root, 'artifacts', 'installers');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? String(process.argv[onlyIndex + 1] || '') : '';
const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (commitResult.error || commitResult.status !== 0) throw new Error('Unable to capture component build HEAD');
const buildCommit = commitResult.stdout.trim();
const packages = fs.readdirSync(extensionRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
  const directory = path.join(extensionRoot, entry.name); const packagePath = path.join(directory, 'package.json');
  if (!fs.existsSync(packagePath)) return [];
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!manifest.photoflowComponent || !manifest.scripts?.['package:host']) return [];
  const componentManifestPath = path.join(directory, String(manifest.photoflowComponent.manifest || ''));
  if (!fs.existsSync(componentManifestPath)) throw new Error(`Component manifest missing: ${entry.name}`);
  const componentManifest = JSON.parse(fs.readFileSync(componentManifestPath, 'utf8'));
  return [{ directory, id: entry.name, version: String(componentManifest.version || '') }];
}).filter(component => !only || component.id === only);
if (only && !packages.length) throw new Error(`No buildable component discovered for: ${only}`);
fs.mkdirSync(outputRoot, { recursive: true });
for (const component of packages) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run component orchestration through npm');
  const expectedArchive = path.join(outputRoot, `PhotoFlow-${component.id}-${component.version}-${process.platform}-${process.arch}.zip`);
  fs.rmSync(expectedArchive, { force: true });
  const result = spawnSync(process.execPath, [npmCli, 'run', 'package:host', '--', '--output-dir', outputRoot], { cwd: component.directory, stdio: 'inherit' });
  if (result.error) {
    fs.rmSync(expectedArchive, { force: true });
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    fs.rmSync(expectedArchive, { force: true });
    throw new Error(`Component package failed: ${component.id}`);
  }
  if (!fs.statSync(expectedArchive, { throwIfNoEntry: false })?.isFile() || fs.statSync(expectedArchive).size < 22) {
    fs.rmSync(expectedArchive, { force: true });
    throw new Error(`Component package was not produced: ${component.id} ${component.version}`);
  }
  const verification = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-component-packages.cjs'), '--write-receipts', '--build-commit', buildCommit, expectedArchive], { cwd: root, stdio: 'inherit' });
  if (verification.error) throw verification.error;
  if ((verification.status ?? 1) !== 0) throw new Error(`Component package verification failed; diagnostic archive retained: ${expectedArchive}`);
}
console.log(`Built ${packages.length} discovered component package(s).`);
