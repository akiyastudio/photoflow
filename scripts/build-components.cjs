const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extensions');
const outputRoot = path.join(root, 'artifacts', 'installers');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? String(process.argv[onlyIndex + 1] || '') : '';
const packages = fs.readdirSync(extensionRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
  const directory = path.join(extensionRoot, entry.name); const packagePath = path.join(directory, 'package.json');
  if (!fs.existsSync(packagePath)) return [];
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!manifest.photoflowComponent || !manifest.scripts?.['package:host']) return [];
  return [{ directory, id: entry.name }];
}).filter(component => !only || component.id === only);
if (only && !packages.length) throw new Error(`No buildable component discovered for: ${only}`);
fs.mkdirSync(outputRoot, { recursive: true });
for (const component of packages) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run component orchestration through npm');
  const result = spawnSync(process.execPath, [npmCli, 'run', 'package:host', '--', '--output-dir', outputRoot], { cwd: component.directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`Component package failed: ${component.id}`);
}
console.log(`Built ${packages.length} discovered component package(s).`);
