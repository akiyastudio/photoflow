const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
const dist = path.join(root, 'dist');
const packageRoot = path.join(dist, 'component');
const buildRoot = path.join(dist, 'pyinstaller');
const python = process.platform === 'win32' ? path.join(repo, '.venv', 'Scripts', 'python.exe') : path.join(repo, '.venv', 'bin', 'python');
const ffmpegArchive = path.join(repo, 'artifacts', 'python', 'ffmpeg.zip');
const ffmpegManifest = path.join(repo, 'artifacts', 'python', 'ffmpeg-runtime-manifest.json');
if (!fs.existsSync(python)) throw new Error('Python environment is missing; run npm run setup:python');
if (!fs.existsSync(ffmpegArchive) || !fs.existsSync(ffmpegManifest)) throw new Error('Audited FFmpeg artifacts are missing; run npm run build:python preparation first');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(packageRoot, { recursive: true });
const pyinstaller = spawnSync(python, [
  '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm',
  '--specpath', path.join(buildRoot, 'spec'), '--workpath', path.join(buildRoot, 'work'), '--distpath', path.join(buildRoot, 'dist'),
  '--name', 'video-tools-worker', '--paths', path.join(root, 'runtime'), '--exclude-module', 'imageio_ffmpeg',
  '--hidden-import', 'ffmpeg_transcode', '--hidden-import', 'cut_video', '--hidden-import', 'video_preview',
  path.join(root, 'runtime', 'worker.py'),
], { cwd: path.join(root, 'runtime'), stdio: 'inherit' });
if (pyinstaller.error) throw pyinstaller.error;
if ((pyinstaller.status ?? 1) !== 0) process.exit(pyinstaller.status ?? 1);

for (const name of ['component.json', 'service.cjs', 'README.md', 'LICENSES', 'ui']) fs.cpSync(path.join(root, name), path.join(packageRoot, name), { recursive: true });
const runtimeRoot = path.join(packageRoot, 'runtime');
fs.cpSync(path.join(buildRoot, 'dist', 'video-tools-worker'), runtimeRoot, { recursive: true });
const builtExecutable = path.join(runtimeRoot, process.platform === 'win32' ? 'video-tools-worker.exe' : 'video-tools-worker');
if (!fs.existsSync(builtExecutable)) throw new Error('Video tools worker executable was not produced');
for (const name of ['worker.py', 'ffmpeg_transcode.py', 'cut_video.py', 'ffmpeg_utils.py', 'video_preview.py']) fs.copyFileSync(path.join(root, 'runtime', name), path.join(runtimeRoot, name));
fs.copyFileSync(ffmpegArchive, path.join(runtimeRoot, 'ffmpeg.zip'));
fs.copyFileSync(ffmpegManifest, path.join(runtimeRoot, 'ffmpeg-runtime-manifest.json'));
for (const file of manifest.requiredFiles) if (!fs.statSync(path.join(packageRoot, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing ${file}`);

const archive = path.join(dist, `PhotoFlow-${manifest.id}-${manifest.version}-${process.platform}-${process.arch}.zip`);
const quote = value => `'${String(value).replace(/'/g, "''")}'`;
const result = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quote(packageRoot)} -DestinationPath ${quote(archive)} -CompressionLevel Optimal -Force`], { stdio: 'inherit' })
  : spawnSync('python3', ['-c', 'import pathlib,sys,zipfile\ns,t=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])\nwith zipfile.ZipFile(t,"w",zipfile.ZIP_DEFLATED) as z:\n for p in sorted(s.rglob("*")):\n  if p.is_file(): z.write(p,pathlib.Path(s.name)/p.relative_to(s))', packageRoot, archive], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Archive failed: ${result.status}`);
console.log(`Installable component package: ${archive}`);
