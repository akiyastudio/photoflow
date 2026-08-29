const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const forbidden = ['app', '3'].join('');
const ignored = new Set(['.venv', 'dist', 'models', '__pycache__']);
const visit = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(candidate);
    else assert(!fs.readFileSync(candidate, 'utf8').toLowerCase().includes(forbidden), `${path.relative(root, candidate)} retains an external development dependency`);
  }
};
visit(root);
const python = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
assert(fs.statSync(python, { throwIfNoEntry: false })?.isFile(), 'plugin-private Python must exist after setup');
const probe = spawnSync(python, ['-c', "import faster_whisper,opencc,sys,pathlib; root=pathlib.Path(sys.prefix).resolve(); assert pathlib.Path(faster_whisper.__file__).resolve().is_relative_to(root); assert pathlib.Path(opencc.__file__).resolve().is_relative_to(root); print('owned')"], { encoding: 'utf8' });
assert.equal(probe.status, 0, probe.stderr); assert.match(probe.stdout, /owned/);
assert(!fs.existsSync(path.join(root, '.venv', 'Lib', 'site-packages', 'photoflow-transcription-seed.pth')), 'legacy external site-packages link is removed');
const cfg = fs.readFileSync(path.join(root, '.venv', 'pyvenv.cfg'), 'utf8'); assert(!cfg.toLowerCase().includes(forbidden)); const cfgExecutable = cfg.split(/\r?\n/).find(line => /^executable\s*=/i.test(line)) || ''; const cfgCommand = cfg.split(/\r?\n/).find(line => /^command\s*=/i.test(line)) || ''; const cfgCommandSource = cfgCommand.split(/\s+-m\s+venv\s+/i)[0]; for (const source of [cfgExecutable, cfgCommandSource]) assert(!/(?:^|[\\/])\.venv(?:[\\/]|$)/i.test(source), 'pyvenv executable/command source is a base interpreter, not another venv');
const setupSource = fs.readFileSync(path.join(root, 'scripts', 'setup-python.cjs'), 'utf8'); assert(setupSource.includes('cfgIsPolluted() || ownershipProbe().status === 3') && setupSource.includes('fs.rmSync(venvRoot, { recursive: true, force: true })'), 'setup rebuilds an existing environment whose config, module paths, or site paths are externally polluted');
const { resolveRuntime, listModels, isCompleteModelDirectory, resolveSafeModelRoot } = require('../service.cjs');
const savedPython = process.env.PHOTOFLOW_TRANSCRIPTION_PYTHON; const savedExecutable = process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE;
delete process.env.PHOTOFLOW_TRANSCRIPTION_PYTHON; delete process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE;
try { const runtime = resolveRuntime(); assert.equal(runtime.source, 'plugin-development'); assert.equal(path.resolve(runtime.command), path.resolve(python)); }
finally { if (savedPython === undefined) delete process.env.PHOTOFLOW_TRANSCRIPTION_PYTHON; else process.env.PHOTOFLOW_TRANSCRIPTION_PYTHON = savedPython; if (savedExecutable === undefined) delete process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE; else process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE = savedExecutable; }
const catalog = listModels(); assert.equal(catalog.placement, 'models/<model-id>'); assert.equal(catalog.downloadPolicy, 'manual-only'); assert(!JSON.stringify(catalog).includes(root)); assert(catalog.models.some(item => item.id === 'large-v3' && item.installed));
assert.equal(isCompleteModelDirectory('../large-v3'), false); assert.equal(isCompleteModelDirectory('repo/name'), false);
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'video-transcription-model-link-')); const link = path.join(root, 'models', 'base');
try { for (const name of ['config.json', 'model.bin', 'tokenizer.json']) fs.writeFileSync(path.join(outside, name), '{}'); if (!fs.existsSync(link)) { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(isCompleteModelDirectory('base'), false, 'a model link escaping the plugin model root is rejected'); fs.unlinkSync(link); } }
finally { if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link); fs.rmSync(outside, { recursive: true, force: true }); }
const temporaryComponent = fs.mkdtempSync(path.join(os.tmpdir(), 'video-transcription-component-root-')); const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-transcription-model-root-')); const redirectedModels = path.join(temporaryComponent, 'models');
try { fs.mkdirSync(path.join(outsideRoot, 'large-v3')); for (const name of ['config.json', 'model.bin', 'tokenizer.json']) fs.writeFileSync(path.join(outsideRoot, 'large-v3', name), '{}'); fs.symlinkSync(outsideRoot, redirectedModels, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(resolveSafeModelRoot(temporaryComponent, redirectedModels), '', 'a models root redirected outside the plugin is rejected by the service'); fs.copyFileSync(path.join(root, 'engine.py'), path.join(temporaryComponent, 'engine.py')); const escaped = spawnSync(python, ['-c', `import sys;sys.path.insert(0,${JSON.stringify(temporaryComponent)});import engine;engine.model_source('large-v3')`], { encoding: 'utf8' }); assert.notEqual(escaped.status, 0, 'the engine also rejects an escaped models root'); }
finally { if (fs.lstatSync(redirectedModels, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(redirectedModels); fs.rmSync(temporaryComponent, { recursive: true, force: true }); fs.rmSync(outsideRoot, { recursive: true, force: true }); }
const packageScript = fs.readFileSync(path.join(root, 'scripts', 'package-component.cjs'), 'utf8'); assert(packageScript.includes("const modelRoot = valueAfter('--model-root')")); assert(!/const files\s*=\s*\[[^\]]*models/s.test(packageScript), 'default package inputs exclude plugin-local models');
console.log('video-transcription self-contained runtime, zero external references, safe model discovery, and thin-package policy tests passed');
