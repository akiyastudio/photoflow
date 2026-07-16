const { existsSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const root = join(__dirname, '..');
const venvPython = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : join(root, '.venv', 'bin', 'python');
const python = existsSync(venvPython) ? venvPython : 'python';

const result = spawnSync(python, [
  '-m', 'PyInstaller', '--onefile', '--clean', '--specpath', 'build/specs',
  '--name', 'tools', '--exclude-module', 'imageio_ffmpeg',
  '--exclude-module', 'torch', '--exclude-module', 'torchvision',
  '--exclude-module', 'torchaudio', '--exclude-module', 'triton',
  '--exclude-module', 'PIL._avif', '--exclude-module', 'PIL._imagingmath',
  '--exclude-module', 'PIL._imagingtk', '--exclude-module', 'PIL._webp',
  'tools.py',
], { cwd: join(root, 'python'), stdio: 'inherit' });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
