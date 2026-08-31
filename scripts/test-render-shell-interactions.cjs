const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const shellLayout = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'AppShellLayout.tsx'), 'utf8');
for (const [name, source] of [['shell', shellLayout]]) {
  assert(source.includes('setPointerCapture') && source.includes('releasePointerCapture'), `${name} column resizing must own pointer capture`);
  assert(source.includes('cleanupRef.current?.()'), `${name} column resizing must clean listeners during unmount`);
}
assert(shellLayout.includes('moveEvent.pointerId !== pointerId') && shellLayout.includes('finishEvent.pointerId !== pointerId'), 'column dragging must ignore move/up/cancel events from other pointers');
assert(shellLayout.includes("addEventListener('lostpointercapture'") && shellLayout.includes("addEventListener('blur'"), 'column dragging must clean up on capture loss and window blur');
assert(shellLayout.includes('if (cleaned) return') && shellLayout.includes('cleaned = true'), 'column drag cleanup must be idempotent across competing terminal events');
const chrome = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'AppChrome.tsx'), 'utf8');
assert(chrome.includes('bg-blue-600 hover:bg-blue-700 text-white'), 'the update download action must retain readable hover contrast');
console.log('render shell interaction regression tests passed');
