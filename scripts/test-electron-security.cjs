const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const {
  createSecureIpcMain,
  isTrustedRendererUrl,
  normalizeBundledPythonTool,
  normalizeDevelopmentRendererUrl,
  normalizeExternalUrl,
  validateRendererPythonInvocation,
} = require('../electron/security-policy.cjs');
const {
  normalizeProjectFileListFilter,
  projectFileListEntryMatchesFilter,
  projectFileListSessionMatches,
} = require('../electron/modules/workspace-ipc.cjs');

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

const developmentRendererUrl = 'http://localhost:61234';
assert.equal(normalizeDevelopmentRendererUrl('http://localhost:61234/'), developmentRendererUrl);
assert.throws(() => normalizeDevelopmentRendererUrl('http://127.0.0.1:61234/'), /localhost/);
assert.throws(() => normalizeDevelopmentRendererUrl('http://localhost:61234/path'), /localhost/);
assert(isTrustedRendererUrl('http://localhost:61234/tools?tab=one', { development: true, developmentRendererUrl, rendererFile }));
assert(!isTrustedRendererUrl('http://localhost:5173/', { development: true, developmentRendererUrl, rendererFile }));
assert(!isTrustedRendererUrl('http://localhost.evil.test:61234/', { development: true, developmentRendererUrl, rendererFile }));
assert(!isTrustedRendererUrl('http://127.0.0.1:61234/', { development: true, developmentRendererUrl, rendererFile }));
assert(isTrustedRendererUrl(pathToFileURL(rendererFile).toString(), { rendererFile }));
assert(!isTrustedRendererUrl(pathToFileURL(path.join(root, 'other.html')).toString(), { rendererFile }));

assert(normalizeExternalUrl('https://github.com/akiyastudio/photoflow'));
assert.strictEqual(normalizeExternalUrl('https://qingstudio.cn/'), 'https://qingstudio.cn/');
assert(normalizeExternalUrl('https://pan.quark.cn/s/example'));
assert(normalizeExternalUrl('mailto:akiyastudio@qq.com'));
assert.strictEqual(normalizeExternalUrl('mailto:other@example.com'), null);
assert.strictEqual(normalizeExternalUrl('mailto:akiyastudio@qq.com?body=%0d%0aInjected'), null);
assert.strictEqual(normalizeExternalUrl('http://github.com/akiyastudio/photoflow'), null);
assert.strictEqual(normalizeExternalUrl('file:///C:/Windows/System32/calc.exe'), null);
assert.strictEqual(normalizeExternalUrl('https://evil.example/download'), null);
assert.strictEqual(normalizeExternalUrl('https://github.com@example.test/download'), null);

const normalizedFileListFilter = normalizeProjectFileListFilter({ query: '  Wedding   FILM  ', kinds: ['video', 'VIDEO', 'invalid'], extensions: ['MOV', '.mov'] });
assert.deepStrictEqual(normalizedFileListFilter.kinds, ['video']);
assert.deepStrictEqual(normalizedFileListFilter.extensions, ['.mov']);
assert.strictEqual(normalizedFileListFilter.query, 'wedding film');
assert.strictEqual(normalizeProjectFileListFilter({ query: `  ${'A'.repeat(220)}  ` }).query.length, 160, 'file-list queries must have a bounded normalized length');
assert(projectFileListEntryMatchesFilter('Our Wedding Film.mov', 'video', '.mov', normalizedFileListFilter), 'project-root query must keep a matching file');
assert(!projectFileListEntryMatchesFilter('Portrait Film.mov', 'video', '.mov', normalizedFileListFilter), 'project-root query must reject a non-matching file');
const emptyQueryFilter = normalizeProjectFileListFilter({ query: '   ', kinds: ['video'] });
assert(projectFileListEntryMatchesFilter('Any Name.mov', 'video', '.mov', emptyQueryFilter), 'an empty query must preserve whole-scope listing behavior');
const fileListSession = { root: 'C:\\workspace\\project', scope: 'C:\\workspace\\project', filterSignature: normalizedFileListFilter.signature };
assert(projectFileListSessionMatches(fileListSession, fileListSession.root, fileListSession.scope, normalizedFileListFilter));
assert(!projectFileListSessionMatches(fileListSession, 'D:\\workspace\\project', fileListSession.scope, normalizedFileListFilter), 'cursor must be bound to its project root');
assert(!projectFileListSessionMatches(fileListSession, fileListSession.root, `${fileListSession.scope}\\child`, normalizedFileListFilter), 'cursor must be bound to its scope');
assert(!projectFileListSessionMatches(fileListSession, fileListSession.root, fileListSession.scope, normalizeProjectFileListFilter({ query: 'portrait film', kinds: ['video'], extensions: ['.mov'] })), 'changing query must invalidate the cursor signature');
assert(!projectFileListSessionMatches(fileListSession, fileListSession.root, fileListSession.scope, normalizeProjectFileListFilter({ query: 'wedding film', kinds: ['image'], extensions: ['.mov'] })), 'changing file type must invalidate the cursor signature');

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
    const toastViewPreload = fs.readFileSync(path.join(root, 'electron', 'toast-view-preload.cjs'), 'utf8');
    const toastViewManager = fs.readFileSync(path.join(root, 'electron', 'services', 'toast-view-manager.cjs'), 'utf8');
    const workspaceIpc = fs.readFileSync(path.join(root, 'electron', 'modules', 'workspace-ipc.cjs'), 'utf8');
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
    assert(main.includes('new ToastViewManager({ WebContentsView'), 'Toast must remain a sandboxed child view rather than a second window');
    assert(toastViewManager.includes('sandbox: true') && toastViewManager.includes("setWindowOpenHandler(() => ({ action: 'deny' }))") && toastViewManager.includes('setPermissionRequestHandler'), 'Toast child view must deny navigation, windows, and permissions');
    assert(toastViewPreload.includes("contextBridge.exposeInMainWorld('toastViewAPI'") && !toastViewPreload.includes('webUtils') && !toastViewPreload.includes('shell'), 'Toast preload must expose only its narrow IPC contract');
    assert(preload.includes('getPathForFile: (file) => webUtils.getPathForFile(file)'));
    assert(preload.includes("ipcRenderer.invoke('workspace-browse-shortcut-preview', workspacePath, status, name, relativePath)"), 'shortcut previews must accept only project identity and a project-relative shortcut path');
    assert(preload.includes("ipcRenderer.invoke('workspace-list-files', workspacePath, status, name, scopeRelativePath, pageSize, cursor, filter)") && preload.includes("ipcRenderer.invoke('workspace-cancel-list-files', cursor)"), 'recursive file listing and cancellation must expose only the bounded main-process IPC');
    const shortcutPreviewHandler = workspaceIpc.slice(workspaceIpc.indexOf("ipcMain.handle('workspace-browse-shortcut-preview'"), workspaceIpc.indexOf("ipcMain.handle('workspace-search-files'"));
    assert(shortcutPreviewHandler.includes("path.extname(shortcutPath).toLowerCase() !== '.lnk'") && shortcutPreviewHandler.includes('assertInside(root') && shortcutPreviewHandler.includes('shell.readShortcutLink(target)'), 'main must validate and resolve shortcut files itself');
    assert(!shortcutPreviewHandler.includes('children.slice(0, 12)') && shortcutPreviewHandler.includes('entries.length >= previewLimit') && shortcutPreviewHandler.includes('maximumInspectedPreviewChildren') && shortcutPreviewHandler.includes('readOnly: true') && shortcutPreviewHandler.includes('viaShortcut: true'), 'external shortcut previews must scan a bounded number of children until enough valid read-only candidates are found');
    assert(shortcutPreviewHandler.indexOf('mediaService.grantRoot(target)') > shortcutPreviewHandler.indexOf('fs.promises.readdir(target'), 'shortcut targets must be granted only after the final directory is readable');
    assert(!shortcutPreviewHandler.includes('targetPath =') && !preload.includes('browseProjectShortcutPreview: (target'), 'renderer must not supply an external shortcut target path');
    const listFilesHandler = workspaceIpc.slice(workspaceIpc.indexOf("ipcMain.handle('workspace-list-files'"), workspaceIpc.indexOf("ipcMain.handle('workspace-recent-files'"));
    assert(listFilesHandler.includes('assertInside(root') && listFilesHandler.includes('assertExistingInside(root') && listFilesHandler.includes('maximumDirectoriesPerPage = 32') && listFilesHandler.includes('maximumInspectedEntriesPerPage = 1000') && listFilesHandler.includes('Math.min(200'), 'recursive listings must validate scope and enforce per-page work limits');
    assert(listFilesHandler.includes('projectFileListSessionMatches(session, root, scope, filter)'), 'file-list cursors must be bound to project root, scope, query, and file type filter');
    assert(!listFilesHandler.includes('readShortcutLink') && !listFilesHandler.includes('thumbnail') && !listFilesHandler.includes('xmp'), 'plain recursive listings must not follow shortcuts or read media content');
    const sourcePathPicker = await fs.promises.readFile(path.join(root, 'src/components/SourcePathPicker.tsx'), 'utf8');
    assert(projectWorkspace.includes('projectWorkspaceClient.getPathForFile(file)') && sourcePathPicker.includes('window.electronAPI.getPathForFile(file)'));
    assert(!projectWorkspace.includes('File & { path?: string }') && !toolViews.includes('File & { path?: string }'));
    let exposedElectronApi;
    const preloadInvocations = [];
    vm.runInNewContext(preload, {
      require: moduleName => {
        assert.strictEqual(moduleName, 'electron');
        return {
          contextBridge: { exposeInMainWorld: (name, api) => { if (name === 'electronAPI') exposedElectronApi = api; } },
          ipcRenderer: {
            invoke: (...args) => { preloadInvocations.push(args); return Promise.resolve({ success: true }); },
            on: () => undefined,
            removeListener: () => undefined,
            send: () => undefined,
          },
          webUtils: { getPathForFile: () => '' },
        };
      },
      console,
      setTimeout,
      clearTimeout,
    }, { filename: 'electron/preload.cjs' });
    const inspectedPaths = ['C:\\media\\one.jpg'];
    const inspectionOptions = { includeFolderFiles: true, extensions: ['.jpg'] };
    await exposedElectronApi.inspectSourcePaths(inspectedPaths, inspectionOptions);
    assert.deepStrictEqual(preloadInvocations.at(-1), ['inspect-source-paths', inspectedPaths, inspectionOptions], 'preload must forward source inspection paths and options unchanged');
    assert(systemIpc.includes("ipcMain.handle('inspect-source-paths'") && systemIpc.includes('.slice(0, 4096)') && systemIpc.includes('value.length <= 32768'), 'source-kind inspection must remain bounded');
    assert(systemIpc.includes('validateRendererPythonInvocation(scriptName, args, requestId)'));
    assert(html.includes('Content-Security-Policy'));
    assert(html.includes("object-src 'none'"));
    process.stdout.write('Electron security policy tests passed.\n');
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
