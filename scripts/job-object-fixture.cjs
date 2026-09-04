const { spawn } = require('child_process');

const mode = process.argv[2];
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === 'natural') {
  write({ type: 'fixture', pid: process.pid, value: process.argv[4] || '' });
  process.exitCode = Number(process.argv[3] || 0);
} else if (mode === 'jsonl-eof') {
  process.stdout.write(JSON.stringify({ type: 'tail', pid: process.pid }));
} else if (mode === 'stdin-eof') {
  process.stdin.resume(); process.stdin.once('end', () => write({ type: 'stdin-eof', pid: process.pid }));
  setTimeout(() => { process.stderr.write('stdin did not reach EOF'); process.exit(9); }, 3000).unref();
} else if (mode === 'wait') {
  write({ type: 'wait', pid: process.pid });
  setInterval(() => undefined, 1000);
} else if (mode === 'child') {
  const grandchild = spawn(process.execPath, [__filename, 'wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  grandchild.stdout.once('data', data => { process.stdout.write(data); write({ type: 'child', pid: process.pid, grandchildPid: grandchild.pid }); });
  setInterval(() => undefined, 1000);
} else if (mode === 'root-tree') {
  const child = spawn(process.execPath, [__filename, 'child'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
      const value = JSON.parse(line);
      if (value.type === 'child') { write({ type: 'root', pid: process.pid, childPid: child.pid }); process.exit(Number(process.argv[3] || 0)); }
    }
  });
} else if (mode === 'root-one-child') {
  const child = spawn(process.execPath, [__filename, 'wait'], { detached: true, stdio: 'ignore', windowsHide: true });
  write({ type: 'root', pid: process.pid, childPid: child.pid }); process.exit(Number(process.argv[3] || 0));
} else {
  process.stderr.write('unknown fixture mode'); process.exit(64);
}
