const { existsSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const root = join(__dirname, '..');
const venvPython = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : join(root, '.venv', 'bin', 'python');
const python = existsSync(venvPython) ? venvPython : 'python';
const cascadeProbe = spawnSync(python, ['-c', 'import cv2; print(cv2.data.haarcascades)'], { cwd: root, encoding: 'utf8' });
if (cascadeProbe.error || (cascadeProbe.status ?? 1) !== 0) throw cascadeProbe.error || new Error(cascadeProbe.stderr || 'Unable to locate OpenCV cascade data');
const cascadeDirectory = cascadeProbe.stdout.trim();
const dataSeparator = process.platform === 'win32' ? ';' : ':';
const cascadeDataArgs = [
  '--add-data', `${join(cascadeDirectory, 'haarcascade_frontalface_alt2.xml')}${dataSeparator}cv2/data`,
  '--add-data', `${join(cascadeDirectory, 'haarcascade_profileface.xml')}${dataSeparator}cv2/data`,
];

const result = spawnSync(python, [
  '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm', '--specpath', 'build/specs',
  '--name', 'tools', '--exclude-module', 'imageio_ffmpeg',
  '--exclude-module', 'torch', '--exclude-module', 'torchvision',
  '--exclude-module', 'torchaudio', '--exclude-module', 'triton',
  '--exclude-module', 'PIL._avif', '--exclude-module', 'PIL._imagingmath',
  '--exclude-module', 'PIL._imagingtk', '--exclude-module', 'PIL._webp',
  ...cascadeDataArgs,
  '--hidden-import', 'catch', '--hidden-import', 'classify',
  '--hidden-import', 'cut_video', '--hidden-import', 'face_patch', '--hidden-import', 'png_to_jpg',
  '--hidden-import', 'rename', '--hidden-import', 'research',
  '--hidden-import', 'thumbnail_db', '--hidden-import', 'video_preview',
  'tools.py',
], { cwd: join(root, 'python'), stdio: 'inherit' });

if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const thumbnailWorker = spawnSync(python, [
  '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm', '--specpath', 'build/specs',
  '--name', 'thumbnail-image-worker',
  '--exclude-module', 'numpy', '--exclude-module', 'scipy',
  '--exclude-module', 'matplotlib', '--exclude-module', 'cv2',
  '--exclude-module', 'torch', '--exclude-module', 'tkinter',
  '--exclude-module', 'PIL.ImageTk', '--exclude-module', 'PIL.ImageQt',
  'thumbnail_image.py',
], { cwd: join(root, 'python'), stdio: 'inherit' });

if (thumbnailWorker.error) throw thumbnailWorker.error;
if ((thumbnailWorker.status ?? 1) !== 0) process.exit(thumbnailWorker.status ?? 1);

const workspaceWorker = spawnSync(python, [
  '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm', '--specpath', 'build/specs',
  '--name', 'workspace-db-worker',
  '--exclude-module', 'numpy', '--exclude-module', 'scipy',
  '--exclude-module', 'matplotlib', '--exclude-module', 'cv2',
  '--exclude-module', 'torch', '--exclude-module', 'PIL',
  'workspace_db.py',
], { cwd: join(root, 'python'), stdio: 'inherit' });

if (workspaceWorker.error) throw workspaceWorker.error;
process.exit(workspaceWorker.status ?? 1);
