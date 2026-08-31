const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const shellLayout = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'AppShellLayout.tsx'), 'utf8');
for (const [name, source] of [['shell', shellLayout]]) {
  assert(source.includes('setPointerCapture') && source.includes('releasePointerCapture'), `${name} column resizing must own pointer capture`);
  assert(source.includes('cleanupRef.current?.()'), `${name} column resizing must clean listeners during unmount`);
}
const chrome = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'AppChrome.tsx'), 'utf8');
assert(chrome.includes('bg-blue-600 hover:bg-blue-700 text-white'), 'the update download action must retain readable hover contrast');
console.log('render shell interaction regression tests passed');
