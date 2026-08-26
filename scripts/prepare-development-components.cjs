const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { developmentRoots } = require('../electron/component-development.cjs');

const projectRoot = path.resolve(__dirname, '..');
const packages = [];
for (const root of developmentRoots({ projectRoot })) {
  const candidates = [root, ...fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink?.()).map(entry => path.join(root, entry.name))];
  for (const directory of candidates) {
    const packagePath = path.join(directory, 'package.json');
    const stat = fs.lstatSync(packagePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const script = manifest.photoflowComponent?.development?.prepare;
    if (!script) continue;
    if (typeof script !== 'string' || !/^[a-z0-9:._-]{1,80}$/i.test(script) || !manifest.scripts?.[script]) throw new Error(`Invalid development prepare declaration: ${packagePath}`);
    packages.push({ directory, name: manifest.name || path.basename(directory), script });
  }
}
for (const component of packages) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run development preparation through npm');
  const result = spawnSync(process.execPath, [npmCli, 'run', component.script], { cwd: component.directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`Development component prepare failed: ${component.name}`);
}
console.log(`Prepared ${packages.length} discovered development component(s).`);
