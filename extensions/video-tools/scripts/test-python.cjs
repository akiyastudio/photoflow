const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const python = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
for (const test of ['test-cut-video.py', 'test-media-encoder.py', 'test-video-trim-real.py']) {
  const result = spawnSync(python, [path.join(root, 'tests', test)], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
