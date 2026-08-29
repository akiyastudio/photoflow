const fs = require('fs');
// Plugin-owned packaging entrypoint.
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') throw new Error('The prepared advanced engine package can only be exported on Windows with WSL 2.');
const root = path.resolve(__dirname, '..');
const componentManifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const version = componentManifest.version;
const advancedRuntimeApiVersion = Number(componentManifest.advancedRuntime?.apiVersion);
if (!Number.isInteger(advancedRuntimeApiVersion) || advancedRuntimeApiVersion < 1) throw new Error('Team-retouch advanced runtime API version is missing');
const outputOption = process.argv.indexOf('--output-dir');
const releaseRoot = outputOption >= 0 ? path.resolve(process.argv[outputOption + 1]) : path.join(root, 'dist');
const outputPath = path.join(releaseRoot, `PhotoFlow-team-retouch-advanced-${version}-win32-x64.zip`);
fs.mkdirSync(releaseRoot, { recursive: true });
const result = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(root, 'scripts', 'create-advanced-offline-package.ps1'),
  '-ComponentVersion', version,
  '-AdvancedRuntimeApiVersion', String(advancedRuntimeApiVersion),
  '-OutputPath', outputPath,
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) throw new Error(`Advanced package export failed with code ${result.status}`);
