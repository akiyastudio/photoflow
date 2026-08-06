const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  createSecureIpcMain,
  isTrustedRendererUrl,
  normalizeBundledPythonTool,
  normalizeExternalUrl,
  validateRendererPythonInvocation,
} = require('../electron/security-policy.cjs');

const root = path.resolve(__dirname, '..');
const rendererFile = path.join(root, 'dist', 'index.html');

assert.strictEqual(normalizeBundledPythonTool('classify'), 'classify.py');
assert.throws(() => normalizeBundledPythonTool('../../Windows/System32/calc'), /Invalid Python tool name/);
assert.throws(() => normalizeBundledPythonTool('classify.py/../calc'), /Invalid Python tool name/);
assert.strictEqual(validateRendererPythonInvocation('research.py', ['--path', 'C:\\media'], 'abcd1234').scriptName, 'research.py');
assert.strictEqual(validateRendererPythonInvocation('ffmpeg_transcode.py', ['C:\\media\\clip.mov'], 'abcd1234').scriptName, 'ffmpeg_transcode.py');
assert.throws(() => validateRendererPythonInvocation('workspace_db.py', [], 'abcd1234'), /not available/);
assert.throws(() => validateRendererPythonInvocation('classify.py', ['safe\n--overwrite'], 'abcd1234'), /Invalid Python tool argument/);
assert.throws(() => validateRendererPythonInvocation('classify.py', [], 'short'), /request identifier/);

assert(isTrustedRendererUrl('http://localhost:5173/tools?tab=one', { development: true, rendererFile }));
assert(!isTrustedRendererUrl('http://localhost.evil.test:5173/', { development: true, rendererFile }));
assert(!isTrustedRendererUrl('http://127.0.0.1:5173/', { development: true, rendererFile }));
assert(isTrustedRendererUrl(pathToFileURL(rendererFile).toString(), { rendererFile }));
assert(!isTrustedRendererUrl(pathToFileURL(path.join(root, 'other.html')).toString(), { rendererFile }));

assert(normalizeExternalUrl('https://github.com/akiyastudio/photoflow'));
assert(normalizeExternalUrl('https://pan.quark.cn/s/example'));
assert(normalizeExternalUrl('mailto:akiyastudio@qq.com'));
assert.strictEqual(normalizeExternalUrl('mailto:other@example.com'), null);
assert.strictEqual(normalizeExternalUrl('mailto:akiyastudio@qq.com?body=%0d%0aInjected'), null);
assert.strictEqual(normalizeExternalUrl('http://github.com/akiyastudio/photoflow'), null);
assert.strictEqual(normalizeExternalUrl('file:///C:/Windows/System32/calc.exe'), null);
assert.strictEqual(normalizeExternalUrl('https://evil.example/download'), null);
assert.strictEqual(normalizeExternalUrl('https://github.com@example.test/download'), null);

const registered = {};
const rawIpcMain = {
  handle: (channel, listener) => { registered[`handle:${channel}`] = listener; },
  on: (channel, listener) => { registered[`on:${channel}`] = listener; },
  once: (channel, listener) => { registered[`once:${channel}`] = listener; },
  removeHandler: channel => { delete registered[`handle:${channel}`]; },
};
let rejected = 0;
const secureIpcMain = createSecureIpcMain({
  ipcMain: rawIpcMain,
  isTrustedEvent: event => event.trusted === true,
  onRejected: () => { rejected += 1; },
});
secureIpcMain.handle('read', async (_event, value) => value);
secureIpcMain.on('write', (_event, value) => { registered.value = value; });

Promise.resolve()
  .then(async () => {
    assert.strictEqual(await registered['handle:read']({ trusted: true }, 'ok'), 'ok');
    await assert.rejects(registered['handle:read']({ trusted: false }, 'blocked'), /Unauthorized IPC sender/);
    registered['on:write']({ trusted: false }, 'blocked');
    assert.strictEqual(registered.value, undefined);
    registered['on:write']({ trusted: true }, 'ok');
    assert.strictEqual(registered.value, 'ok');
    assert.strictEqual(rejected, 2);

    const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
    const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
    const projectWorkspace = fs.readFileSync(path.join(root, 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
    const toolViews = fs.readFileSync(path.join(root, 'src', 'features', 'tools', 'ToolViews.tsx'), 'utf8');
    const securityPolicy = fs.readFileSync(path.join(root, 'electron', 'security-policy.cjs'), 'utf8');
    const systemIpc = fs.readFileSync(path.join(root, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert(main.includes('createElectronSecurity({'));
    assert(securityPolicy.includes('setWindowOpenHandler'));
    assert(securityPolicy.includes("webContents.on('will-navigate'"));
    assert(securityPolicy.includes('setPermissionRequestHandler'));
    assert(main.includes('sandbox: true'));
    assert(preload.includes('getPathForFile: (file) => webUtils.getPathForFile(file)'));
    assert(projectWorkspace.includes('window.electronAPI.getPathForFile(file)') && toolViews.includes('window.electronAPI.getPathForFile(file)'));
    assert(!projectWorkspace.includes('File & { path?: string }') && !toolViews.includes('File & { path?: string }'));
    assert(systemIpc.includes('validateRendererPythonInvocation(scriptName, args, requestId)'));
    assert(html.includes('Content-Security-Policy'));
    assert(html.includes("object-src 'none'"));
    process.stdout.write('Electron security policy tests passed.\n');
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
