const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Linter } = require('eslint');
const {
  ALLOWED_COMPONENT_FEATURE_EDGES,
  ALLOWED_IPC_REGISTRAR_EDGES,
  ALLOWED_RENDERER_FEATURE_EDGES,
  ENTRY_FILE_BUDGETS,
  REVIEWED_FEATURE_COUPLED_SHARED_COMPONENTS,
} = require('./source-boundary-policy.cjs');

const root = path.resolve(__dirname, '..');
const normalize = value => value.replaceAll('\\', '/');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(absolute) : [absolute];
});
const sourceFiles = walk(path.join(root, 'src')).filter(file => /\.(?:ts|tsx)$/.test(file));
const electronFiles = walk(path.join(root, 'electron')).filter(file => file.endsWith('.cjs'));
const relativeSpecifiers = source => [
  ...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
  ...source.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g),
  ...source.matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g),
].map(match => match[1]);
const resolveSpecifier = (file, specifier) => normalize(path.relative(root, path.resolve(path.dirname(file), specifier)));

const rendererFeatureEdges = new Set();
const componentFeatureEdges = new Set();
const reviewedFeatureCoupledSharedComponents = new Set(REVIEWED_FEATURE_COUPLED_SHARED_COMPONENTS);
for (const file of sourceFiles) {
  const relativeFile = normalize(path.relative(root, file));
  const source = fs.readFileSync(file, 'utf8');
  for (const specifier of relativeSpecifiers(source)) {
    const target = resolveSpecifier(file, specifier);
    const sourceFeature = /^src\/features\/([^/]+)\//.exec(relativeFile)?.[1];
    const targetFeature = /^src\/features\/([^/]+)\//.exec(target)?.[1];
    if (sourceFeature && targetFeature && sourceFeature !== targetFeature) rendererFeatureEdges.add(`${sourceFeature}->${targetFeature}`);
    if (sourceFeature && reviewedFeatureCoupledSharedComponents.has(target)) rendererFeatureEdges.add(`${sourceFeature}->components`);
    if (relativeFile.startsWith('src/components/') && targetFeature) componentFeatureEdges.add(`components->${targetFeature}`);

    if (relativeFile.startsWith('src/contracts/')) {
      assert(!target.startsWith('src/features/') && !target.startsWith('src/components/') && !target.startsWith('src/platform/'),
        `renderer contract imports an implementation layer: ${relativeFile} -> ${target}`);
    }
    if (relativeFile.startsWith('src/platform/')) {
      assert(target.startsWith('src/contracts/') || target === 'src/types' || target.startsWith('src/types.'),
        `renderer platform adapter may depend only on contracts/types: ${relativeFile} -> ${target}`);
    }
    if (targetFeature === 'versioning' && sourceFeature !== 'versioning') {
      assert(target === 'src/features/versioning/public',
        `versioning internals must be imported through its public API: ${relativeFile} -> ${target}`);
    }
  }
}

const mainSource = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
assert(!/require\(['"]\.\/repositories\/(?:workspace|operations|media|sample-component)-repository/.test(mainSource),
  'the composition root must use domain public APIs rather than repository implementations');
for (const domain of ['workspace', 'file-operations', 'media', 'versioning']) {
  assert(fs.existsSync(path.join(root, 'electron', 'domains', domain, 'public.cjs')), `missing public API for ${domain}`);
}
assert(!fs.existsSync(path.join(root, 'electron', 'domains', 'sample-component')) && !fs.existsSync(path.join(root, 'electron', 'repositories', 'sample-component-repository.cjs')),
  'sample-component business persistence must live only in its component service');

assert(!rendererFeatureEdges.has('search->workspace'),
  'global search must consume reviewed shared UI rather than the workspace composition root');
assert.deepStrictEqual([...rendererFeatureEdges].sort(), [...ALLOWED_RENDERER_FEATURE_EDGES].sort(),
  'renderer feature dependency graph changed; use a public contract or update the reviewed boundary policy');
assert.deepStrictEqual([...componentFeatureEdges].sort(), [...ALLOWED_COMPONENT_FEATURE_EDGES].sort(),
  'shared components gained a new feature dependency; move the contract to a neutral package');

for (const file of electronFiles) {
  const relativeFile = normalize(path.relative(root, file));
  const source = fs.readFileSync(file, 'utf8');
  for (const specifier of relativeSpecifiers(source)) {
    const target = resolveSpecifier(file, specifier);
    if (relativeFile.startsWith('electron/contracts/')) {
      assert(!/^electron\/(?:modules|services|repositories)\//.test(target),
        `main-process contract imports an implementation layer: ${relativeFile} -> ${target}`);
    }
    if (relativeFile.startsWith('electron/repositories/')) {
      assert(!/^electron\/(?:modules|services)\//.test(target),
        `repository imports a higher application layer: ${relativeFile} -> ${target}`);
    }
    if (relativeFile.startsWith('electron/services/')) {
      assert(!target.startsWith('electron/modules/') && target !== 'electron/main.cjs',
        `service imports an IPC/composition layer: ${relativeFile} -> ${target}`);
    }
    if (/^electron\/modules\/[^/]+\.cjs$/.test(relativeFile)) {
      const edge = `${relativeFile}->${target}`;
      assert(!/^electron\/modules\/[^/]+\.cjs$/.test(target) || ALLOWED_IPC_REGISTRAR_EDGES.includes(edge),
        `IPC registrar imports another registrar: ${relativeFile} -> ${target}`);
    }
  }
}

// Each value is a reviewed hard ceiling. Exact shell/IPC baselines are pinned, so one added line still fails this gate.
for (const [relativeFile, maximumLines] of Object.entries(ENTRY_FILE_BUDGETS)) {
  const lineCount = fs.readFileSync(path.join(root, relativeFile), 'utf8').split(/\r?\n/).length;
  assert(lineCount <= maximumLines, `${relativeFile} exceeded its ${maximumLines}-line composition budget (${lineCount})`);
}

const workspaceIpcSource = fs.readFileSync(path.join(root, 'electron', 'modules', 'workspace-ipc.cjs'), 'utf8');
const workspaceImportIpcSource = fs.readFileSync(path.join(root, 'electron', 'modules', 'workspace', 'import-ipc.cjs'), 'utf8');
assert.match(workspaceIpcSource, /registerWorkspaceImportIpc\(\{/,
  'workspace IPC composition root must register the extracted import/progress handlers');
assert(!workspaceImportIpcSource.includes("require('../workspace-ipc.cjs')"),
  'workspace import/progress registrar must not create a cycle back to its composition root');

// The extracted registrar is a dependency-closed unit: no JavaScript built-in is
// implicitly allowed. `module` is the sole free host binding because this file must
// publish its CommonJS API; every executable dependency, including built-ins, is
// declared in the registrar's dependency object and supplied by the composition root.
const workspaceImportAllowedFreeGlobals = Object.freeze({ module: 'readonly' });
const workspaceImportFreeIdentifierErrors = new Linter().verify(workspaceImportIpcSource, {
  parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
  globals: workspaceImportAllowedFreeGlobals,
  rules: { 'no-undef': 'error' },
}).filter(message => message.ruleId === 'no-undef');
assert.deepStrictEqual(workspaceImportFreeIdentifierErrors, [],
  `workspace import/progress registrar has undeclared free identifiers: ${workspaceImportFreeIdentifierErrors.map(message => `${message.message} (${message.line}:${message.column})`).join(', ')}`);

const { registerWorkspaceImportIpc } = require('../electron/modules/workspace/import-ipc.cjs');
const registeredWorkspaceImportChannels = [];
registerWorkspaceImportIpc({
  ipcMain: { handle: channel => registeredWorkspaceImportChannels.push(channel) },
});
assert.deepStrictEqual(registeredWorkspaceImportChannels, [
  'workspace-create-progress-folder',
  'workspace-media-workflow-import-commit',
  'workspace-media-workflow-import-recover',
  'workspace-open-version',
  'workspace-open-project',
  'workspace-open-entry',
  'workspace-extract-office-images',
  'workspace-extract-screenshot-main-images',
  'workspace-trim-video',
  'workspace-cancel-video-trim',
  'workspace-import-files',
  'workspace-import-progress-files',
], 'workspace import/progress registrar changed its IPC channel contract or registration order');

console.log('Source package boundary tests passed.');
