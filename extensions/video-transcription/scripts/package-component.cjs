const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'); const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
const valueAfter = name => { const index = process.argv.indexOf(name); return index >= 0 ? String(process.argv[index + 1] || '') : ''; };
const outputRoot = path.resolve(valueAfter('--output-dir') || path.join(root, 'dist'));
const packageRoot = path.join(root, 'dist', 'component');
fs.rmSync(packageRoot, { recursive: true, force: true }); fs.mkdirSync(packageRoot, { recursive: true });
const files = ['component.json', 'service.cjs', 'core.cjs', 'engine.py', 'README.md', 'LICENSES', 'ui'];
for (const relative of files) fs.cpSync(path.join(root, relative), path.join(packageRoot, relative), { recursive: true });
const runtime = valueAfter('--runtime');
if (runtime) { const stat = fs.statSync(path.resolve(runtime), { throwIfNoEntry: false }); if (!stat?.isFile()) throw new Error('Specified transcriber runtime is missing'); fs.mkdirSync(path.join(packageRoot, '_internal'), { recursive: true }); fs.copyFileSync(path.resolve(runtime), path.join(packageRoot, '_internal', process.platform === 'win32' ? 'transcriber.exe' : 'transcriber')); }
const modelRoot = valueAfter('--model-root');
if (modelRoot) { const stat = fs.statSync(path.resolve(modelRoot), { throwIfNoEntry: false }); if (!stat?.isDirectory()) throw new Error('Specified model root is missing'); fs.cpSync(path.resolve(modelRoot), path.join(packageRoot, 'models'), { recursive: true }); }
for (const relative of manifest.requiredFiles) if (!fs.statSync(path.join(packageRoot, relative), { throwIfNoEntry: false })?.isFile()) throw new Error(`Packaged component is missing ${relative}`);
fs.mkdirSync(outputRoot, { recursive: true }); const archive = path.join(outputRoot, `PhotoFlow-${manifest.id}-${manifest.version}-${process.platform}-${process.arch}.zip`); fs.rmSync(archive, { force: true });
let result;
if (process.platform === 'win32') {
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quote(packageRoot)} -DestinationPath ${quote(archive)} -CompressionLevel Optimal -Force`], { stdio: 'inherit' });
}
else { const script = 'import pathlib,sys,zipfile\ns,t=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])\nwith zipfile.ZipFile(t,"w",zipfile.ZIP_DEFLATED) as z:\n for p in sorted(s.rglob("*")):\n  if p.is_file(): z.write(p,pathlib.Path(s.name)/p.relative_to(s))'; result = spawnSync('python3', ['-c', script, packageRoot, archive], { stdio: 'inherit' }); }
if (result.error) throw result.error; if ((result.status ?? 1) !== 0) throw new Error(`Archive creation failed with code ${result.status}`);
console.log(`Installable component package: ${archive}${runtime ? ' (self-contained runtime)' : ' (thin runtime-discovery package)'}`);
