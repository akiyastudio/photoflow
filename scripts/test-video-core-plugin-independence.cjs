const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'extensions', 'video-playback-mpv');
const hidden = path.join(root, 'extensions', `.video-playback-mpv.hidden-core-test-${process.pid}`);

assert.equal(path.dirname(source), path.join(root, 'extensions'));
assert.equal(path.dirname(hidden), path.join(root, 'extensions'));
if (!fs.existsSync(source)) throw new Error('plugin source missing before independence test');
if (fs.existsSync(hidden)) throw new Error('temporary plugin hiding directory already exists');

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${args.join(' ')} failed`);
  process.stdout.write(result.stdout || '');
};

const moveFiles = (from, to) => {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const sourceEntry = path.join(from, entry.name);
    const hiddenEntry = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(hiddenEntry, { recursive: true });
      moveFiles(sourceEntry, hiddenEntry);
    } else {
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(sourceEntry, hiddenEntry);
    }
  }
};

try {
  fs.mkdirSync(hidden);
  moveFiles(source, hidden);
  for (const test of [
    'scripts/test-video-playback-architecture.cjs',
    'scripts/test-video-playback-host-security.cjs',
    'scripts/test-video-playback-broker.cjs',
  ]) run(process.execPath, [test]);
  run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', '--pretty', 'false']);
  console.log('Core playback compile and boundary tests pass without plugin source.');
} finally {
  if (fs.existsSync(hidden)) moveFiles(hidden, source);
  if (fs.existsSync(hidden)) fs.rmSync(hidden, { recursive: true });
}
