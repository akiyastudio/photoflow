const assert = require('assert');
const fs = require('fs');
const ts = require('typescript');

const source = fs.readFileSync('src/features/tools/tool-source-selection-model.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, loaded, loaded.exports);

const { resolveInspectedToolSources } = loaded.exports;
const folder = 'C:\\Project\\MOV';
const childVideos = [`${folder}\\one.mov`, `${folder}\\nested\\two.mov`];
assert.deepStrictEqual(resolveInspectedToolSources([{ path: folder, kind: 'folder' }], [folder], childVideos), [
  { path: folder, kind: 'folder' },
], 'a selected folder must remain one source instead of expanding into discovered files');
assert.deepStrictEqual(resolveInspectedToolSources(undefined, [folder], [...childVideos, 'D:\\direct.mov']), [
  { path: folder, kind: 'folder' },
  { path: 'D:\\direct.mov', kind: 'file' },
], 'the staged-upgrade fallback must retain folders and only add files selected outside them');

console.log('Tool source selection tests passed.');
