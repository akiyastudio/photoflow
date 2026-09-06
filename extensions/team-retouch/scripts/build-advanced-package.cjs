const fs = require('fs');
// Plugin-owned packaging entrypoint.
const path = require('path');
const { spawnSync } = require('child_process');
const { validateInputLock } = require('./advanced-release-validator.cjs');
const { advancedRuntimeRoot } = require('./package-output-paths.cjs');

const root = path.resolve(__dirname, '..');
function parseArguments(values) {
  const options = { '--output-dir': advancedRuntimeRoot, '--distro-name': 'PhotoFlowNative', '--linux-user': 'photoflow' };
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index]; const value = values[index + 1];
    if (!Object.hasOwn(options, option) || !value || value.startsWith('--')) throw new Error(`Invalid advanced package argument: ${option}`);
    options[option] = value;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options['--distro-name']) || !/^[a-z_][a-z0-9_-]*$/.test(options['--linux-user'])) throw new Error('Invalid advanced build distribution or Linux user');
  options['--output-dir'] = path.resolve(options['--output-dir']);
  return options;
}
function main(values = process.argv.slice(2)) {
if (process.platform !== 'win32') throw new Error('The prepared advanced engine package can only be exported on Windows with WSL 2.');
const options = parseArguments(values);
const inputLock = path.join(root, 'advanced', 'build-input-lock.json');
const componentManifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const version = componentManifest.version;
const advancedRuntimeApiVersion = Number(componentManifest.advancedRuntime?.apiVersion);
if (!Number.isInteger(advancedRuntimeApiVersion) || advancedRuntimeApiVersion < 1) throw new Error('Team-retouch advanced runtime API version is missing');
if (!fs.existsSync(inputLock)) throw new Error('Reviewed advanced build-input lock is missing; refusing to export an advanced candidate.');
validateInputLock(root, inputLock, { componentVersion: version, advancedRuntimeApiVersion });
const releaseRoot = path.resolve(options['--output-dir']);
const outputPath = path.join(releaseRoot, 'candidates', `PhotoFlow-team-retouch-advanced-${version}-win32-x64.zip`);
fs.mkdirSync(releaseRoot, { recursive: true });
const result = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(root, 'scripts', 'create-advanced-offline-package.ps1'),
  '-ComponentVersion', version,
  '-DistroName', options['--distro-name'],
  '-LinuxUser', options['--linux-user'],
  '-AdvancedRuntimeApiVersion', String(advancedRuntimeApiVersion),
  '-OutputPath', outputPath,
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) throw new Error(`Advanced package export failed with code ${result.status}`);
}
if (require.main === module) main();
module.exports = { parseArguments, main };
