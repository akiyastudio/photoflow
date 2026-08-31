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
const filenameSelectionSource = fs.readFileSync('src/features/tools/filename-selection-model.ts', 'utf8');
const filenameSelectionCompiled = ts.transpileModule(filenameSelectionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const filenameSelectionModule = { exports: {} };
new Function('require', 'module', 'exports', filenameSelectionCompiled)(require, filenameSelectionModule, filenameSelectionModule.exports);
const folder = 'C:\\Project\\MOV';
const childVideos = [`${folder}\\one.mov`, `${folder}\\nested\\two.mov`];
assert.deepStrictEqual(resolveInspectedToolSources([{ path: folder, kind: 'folder' }], [folder], childVideos), [
  { path: folder, kind: 'folder' },
], 'a selected folder must remain one source instead of expanding into discovered files');
assert.deepStrictEqual(resolveInspectedToolSources(undefined, [folder], [...childVideos, 'D:\\direct.mov']), [
  { path: folder, kind: 'folder' },
  { path: 'D:\\direct.mov', kind: 'file' },
], 'the staged-upgrade fallback must retain folders and only add files selected outside them');
assert.deepStrictEqual(resolveInspectedToolSources(undefined, ['/'], ['/a.mov']), [
  { path: '/', kind: 'folder' },
], 'the POSIX root must contain absolute descendants');

(async () => {
  const ownership = filenameSelectionModule.exports.createFilenameSelectionTaskOwnership();
  let releaseOld;
  let running = true;
  const oldGeneration = ownership.begin();
  ownership.setPhase(oldGeneration, 'copy');
  ownership.setOperation(oldGeneration, 'operation-old-a');
  const oldTask = new Promise(resolve => { releaseOld = resolve; }).then(() => {
    if (ownership.finish(oldGeneration)) running = false;
  });
  const staleOperationId = ownership.invalidate();
  running = false;
  assert.equal(staleOperationId, 'operation-old-a');
  assert.deepStrictEqual(ownership.getSnapshot(), { generation: 2, phase: 'idle', operationId: '' }, 'project invalidation must atomically release preflight/confirm/copy state and its operation token');
  const newGeneration = ownership.begin();
  running = true;
  releaseOld();
  await oldTask;
  assert.equal(running, true, 'a late A result must not clear the running state of a new A task after A→B→A');
  assert.equal(ownership.finish(newGeneration), true, 'the current task must retain ownership of cleanup');
  assert.equal(ownership.getSnapshot().phase, 'idle');
  console.log('Tool source selection tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
