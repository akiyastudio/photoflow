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
assert(chrome.includes('data-default-focus="true"') && chrome.includes('querySelectorAll<HTMLElement>') && chrome.includes('previousFocus?.isConnected'), 'the update modal must focus initially, trap tab navigation, and restore its trigger');
assert(chrome.includes('useEscapeLayer(true, onClose, !mandatory, true)'), 'mandatory updates must not escape while optional updates retain close behavior');
assert(!/<button(?![^>]*\btype=)/.test(chrome), 'AppChrome buttons must explicitly use type=button');
const dialogs = fs.readFileSync(path.join(root, 'src', 'components', 'AppDialogProvider.tsx'), 'utf8');
assert(dialogs.includes('aria-describedby={options.message ?') && dialogs.includes('aria-label={promptOptions.message || promptOptions.title}'), 'prompt dialogs must reference only rendered descriptions and name their input');
const progress = fs.readFileSync(path.join(root, 'src', 'components', 'ProgressBar.tsx'), 'utf8');
assert(progress.includes('role="progressbar"') && progress.includes('aria-valuemin={0}') && progress.includes('aria-valuemax={100}'), 'progress bars must expose their range semantics');
assert(progress.includes('aria-valuenow={determinate ? normalized : undefined}') && progress.includes("determinate ? '进度' : '正在处理'"), 'indeterminate progress must omit aria-valuenow and retain an accessible name');
const workspaceTabs = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'useWorkspaceTabs.ts'), 'utf8');
assert(!/setState\(current =>[^\n]*createPageId\(\)/.test(workspaceTabs), 'page ids must never be generated inside React functional updaters');
console.log('render shell interaction regression tests passed');
