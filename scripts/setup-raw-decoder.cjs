const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const python = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');

if (!fs.existsSync(python)) {
  console.error('Python virtual environment is missing. Create .venv before preparing the RAW decoder.');
  process.exit(1);
}

const requirements = path.join(root, 'components', 'raw-decoder-libraw', 'requirements.txt');
const result = spawnSync(python, ['-m', 'pip', 'install', '--requirement', requirements], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
