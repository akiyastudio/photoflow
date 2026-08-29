const assert = require('assert');
const fs = require('fs');
const ts = require('typescript');

const source = fs.readFileSync('src/components/source-path-picker-model.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, loaded, loaded.exports);

const { mergeSourcePaths, parseSourcePathText, removeSourcePath } = loaded.exports;

assert.deepStrictEqual(parseSourcePathText([
  '"C:\\A Folder\\one.mp4" "D:\\two.mov"',
  'E:\\three.mkv; E:\\three.mkv',
].join('\n')), [
  'C:\\A Folder\\one.mp4',
  'D:\\two.mov',
  'E:\\three.mkv',
]);
assert.deepStrictEqual(mergeSourcePaths(
  ['C:\\Media\\Clip.MOV'],
  ['c:/media/clip.mov', 'D:\\next.mov'],
), ['C:\\Media\\Clip.MOV', 'D:\\next.mov']);

const manyPaths = Array.from({ length: 501 }, (_, index) => `C:\\Media\\clip-${index}.mov`);
const afterRemoval = removeSourcePath(manyPaths, manyPaths[10]);
assert.strictEqual(afterRemoval.length, 500, 'removing one visible item must retain every other path beyond the old 500-item display boundary');
assert(afterRemoval.includes(manyPaths[500]), 'paths after the old display boundary must not be discarded');

const pickerSource = fs.readFileSync('src/components/SourcePathPicker.tsx', 'utf8');
for (const marker of ['folderPreviewExtensions', 'includeFolderFiles: true', 'expandedFolders', '全部收起', '展开全部', '个文件']) assert(pickerSource.includes(marker), `source picker folder preview is missing ${marker}`);
const systemIpcSource = fs.readFileSync('electron/modules/system-ipc.cjs', 'utf8');
assert(systemIpcSource.includes("ipcMain.handle('inspect-source-paths'") && systemIpcSource.includes('previewFolder') && systemIpcSource.includes('files.length < 2_000'), 'folder preview scanning must stay bounded in the host');

console.log('Source path picker and folder preview tests passed.');
