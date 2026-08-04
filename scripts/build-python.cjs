const { existsSync, rmSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const root = join(__dirname, '..');
const venvPython = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : join(root, '.venv', 'bin', 'python');
const python = existsSync(venvPython) ? venvPython : 'python';
const sharedWorkerName = 'PhotoFlowImportWorker';

// These workers now share the tools runtime. Remove stale standalone outputs
// so local release inspection cannot mistake them for packaged resources.
for (const retiredOutput of ['thumbnail-image-worker', 'workspace-db-worker', 'tools', 'tools.exe', sharedWorkerName, 'thumbnail-image-worker.exe', 'workspace-db-worker.exe']) {
  rmSync(join(root, 'python', 'dist', retiredOutput), { recursive: true, force: true });
}

const result = spawnSync(python, [
  '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm', '--specpath', 'build/specs',
  '--name', sharedWorkerName, '--exclude-module', 'imageio_ffmpeg', '--exclude-module', 'rawpy',
  '--exclude-module', 'numpy', '--exclude-module', 'scipy', '--exclude-module', 'cv2',
  '--exclude-module', 'torch', '--exclude-module', 'torchvision',
  '--exclude-module', 'torchaudio', '--exclude-module', 'triton',
  '--exclude-module', 'PIL._imagingmath',
  '--exclude-module', 'PIL._imagingtk',
  '--hidden-import', 'catch', '--hidden-import', 'classify', '--hidden-import', 'ffmpeg_transcode',
  '--hidden-import', 'cut_video', '--hidden-import', 'png_to_jpg',
  '--hidden-import', 'rename',
  '--hidden-import', 'thumbnail_db', '--hidden-import', 'thumbnail_image',
  '--hidden-import', 'video_preview', '--hidden-import', 'workspace_db', '--hidden-import', 'backup_db',
  'tools.py',
], { cwd: join(root, 'python'), stdio: 'inherit' });

if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const inspirationTools = spawnSync(python, [
  '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm', '--specpath', 'build/specs',
  '--name', 'inspiration-tools', '--exclude-module', 'imageio_ffmpeg',
  '--exclude-module', 'scipy', '--exclude-module', 'matplotlib',
  '--exclude-module', 'torch', '--exclude-module', 'torchvision',
  '--exclude-module', 'torchaudio', '--exclude-module', 'triton',
  '--exclude-module', 'tkinter', '--exclude-module', 'PIL.ImageTk',
  '--exclude-module', 'PIL.ImageQt', '--exclude-module', 'PIL._avif',
  '--exclude-module', 'PIL._imagingmath', '--exclude-module', 'PIL._imagingtk',
  '--exclude-module', 'PIL._webp',
  '--hidden-import', 'research', '--hidden-import', 'office_media_extract',
  '--hidden-import', 'screenshot_main_image',
  'inspiration_tools.py',
], { cwd: join(root, 'python'), stdio: 'inherit' });

if (inspirationTools.error) throw inspirationTools.error;
process.exit(inspirationTools.status ?? 1);
