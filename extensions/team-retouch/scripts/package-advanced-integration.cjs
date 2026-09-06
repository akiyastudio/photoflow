// Internal Host integration candidate. This never creates a release lock or
// promotes a candidate into the approved base/advanced delivery directories.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashFile, validateInputLock } = require('./advanced-release-validator.cjs');
const { writePackageInventory } = require('./package-notices.cjs');
const { candidateRoot } = require('./package-output-paths.cjs');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
validateInputLock(root, path.join(root, 'advanced/build-input-lock.json'), { componentVersion: manifest.version, advancedRuntimeApiVersion: manifest.advancedRuntime.apiVersion });
const base = path.join(root, 'dist/component');
const baseManifest = JSON.parse(fs.readFileSync(path.join(base, 'component.json'), 'utf8'));
const baseInventory = JSON.parse(fs.readFileSync(path.join(base, 'package-files.json'), 'utf8'));
if (baseManifest.version !== manifest.version || baseInventory.variant !== 'base' || baseInventory.buildMode !== 'release') throw new Error('Build the current formal base package before the internal integration candidate.');
const advancedName = `PhotoFlow-team-retouch-advanced-${manifest.version}-win32-x64.zip`;
const advancedSource = path.join(candidateRoot, advancedName);
const digest = hashFile(advancedSource);
const destination = path.join(candidateRoot, 'host-integration');
fs.mkdirSync(destination, { recursive: true });
const stage = fs.mkdtempSync(path.join(destination, 'assembly-'));
const component = path.join(stage, 'component');
fs.cpSync(base, component, { recursive: true });
fs.cpSync(path.join(root, 'advanced-installer'), path.join(component, 'advanced-installer'), { recursive: true });
for (const name of ['advanced/pairdetr_service.py', 'advanced/sam2_service.py', 'advanced/locks/checkpoints.sha256', 'image_safety.py', 'advanced_geometry.py', 'checkpoint_lock.py']) {
  const target = path.join(component, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, name), target);
}
manifest.requiredFiles = [...new Set([...baseManifest.requiredFiles, ...manifest.requiredFiles, advancedName, 'advanced/pairdetr_service.py', 'advanced/sam2_service.py', 'advanced/locks/checkpoints.sha256', 'image_safety.py', 'advanced_geometry.py', 'checkpoint_lock.py'])];
manifest.advancedRuntime.offlinePackage = { path: advancedName, sha256: digest };
fs.writeFileSync(path.join(component, 'component.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writePackageInventory(component, { componentId: manifest.id, version: manifest.version, buildMode: 'internal-candidate', variant: 'advanced' });
const inventoryPath = path.join(component, 'package-files.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
inventory.files.push({ path: advancedName, size: fs.statSync(advancedSource).size, sha256: digest });
fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
const archive = path.join(destination, `PhotoFlow-${manifest.id}-${manifest.version}-win32-x64.zip`);
const python = path.join(root, '.venv-release/Scripts/python.exe');
const code = 'import pathlib,sys,zipfile\nsource,target,blob=map(pathlib.Path,sys.argv[1:])\nwith zipfile.ZipFile(target,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:\n for item in sorted(source.rglob("*")):\n  if item.is_file(): z.write(item,pathlib.Path("component")/item.relative_to(source))\n z.write(blob,pathlib.Path("component")/blob.name,compress_type=zipfile.ZIP_STORED)';
const result = spawnSync(python, ['-c', code, component, archive, advancedSource], { stdio: 'inherit', windowsHide: true });
if (result.error || result.status !== 0) throw result.error || new Error('Internal integration archive failed');
console.log(`Internal integration candidate (not release-approved): ${archive}`);
