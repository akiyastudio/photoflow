const assert = require('assert/strict');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const blocker = net.createServer();
blocker.listen(0, 'localhost', () => {
  const port = blocker.address().port;
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port)], {
    cwd: repositoryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' },
  });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 20_000);
  child.once('exit', code => {
    clearTimeout(timer); blocker.close();
    assert.notEqual(code, 0, `Vite unexpectedly accepted occupied port ${port}\n${output}`);
    assert.match(output, new RegExp(`Port ${port} is already in use`));
    assert(!output.includes(`localhost:${port + 1}`), 'strict port startup must not silently move to another port');
    console.log('Electron development server contract passed: occupied ports fail without URL divergence.');
  });
  child.once('error', error => { clearTimeout(timer); blocker.close(); throw error; });
});
blocker.once('error', error => { throw error; });
