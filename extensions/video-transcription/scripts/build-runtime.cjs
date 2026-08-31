const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const python = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');
const buildRoot = path.join(root, 'dist', 'pyinstaller');
const runtimeRoot = path.join(root, 'dist', 'runtime');
const executable = path.join(runtimeRoot, process.platform === 'win32' ? 'transcriber.exe' : 'transcriber');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, encoding: options.capture ? 'utf8' : undefined, stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(String(result.stderr || result.stdout || `${command} failed with code ${result.status}`));
  return String(result.stdout || '').trim();
};

run(process.execPath, [path.join(__dirname, 'setup-python.cjs')]);
const pyinstallerProbe = spawnSync(python, ['-m', 'PyInstaller', '--version'], { cwd: root, stdio: 'ignore', windowsHide: true });
if (pyinstallerProbe.status !== 0) run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements-build.txt']);

fs.rmSync(buildRoot, { recursive: true, force: true });
fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.mkdirSync(runtimeRoot, { recursive: true });
run(python, [
  '-m', 'PyInstaller', '--onefile', '--clean', '--noconfirm',
  '--specpath', path.join(buildRoot, 'spec'),
  '--workpath', path.join(buildRoot, 'work'),
  '--distpath', runtimeRoot,
  '--name', 'transcriber',
  '--collect-all', 'faster_whisper',
  '--collect-all', 'ctranslate2',
  '--collect-all', 'av',
  '--collect-all', 'opencc',
  '--collect-all', 'onnxruntime',
  '--collect-all', 'tokenizers',
  path.join(root, 'engine.py'),
]);
if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw new Error(`Transcriber runtime was not produced: ${executable}`);
const diagnosticOutput = run(executable, ['--diagnose'], { capture: true });
const diagnostic = diagnosticOutput.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(frame => frame.type === 'diagnostic-result');
if (!diagnostic?.ready || diagnostic.packaged !== true) throw new Error(`Packaged transcriber diagnostic failed: ${diagnosticOutput}`);
console.log(`Self-contained video transcription runtime: ${executable}`);
