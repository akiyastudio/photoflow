const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ALLOWED_COMPONENT_FEATURE_EDGES,
  ALLOWED_IPC_REGISTRAR_EDGES,
  ALLOWED_RENDERER_FEATURE_EDGES,
  ENTRY_FILE_BUDGETS,
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
for (const file of sourceFiles) {
  const relativeFile = normalize(path.relative(root, file));
  const source = fs.readFileSync(file, 'utf8');
  for (const specifier of relativeSpecifiers(source)) {
    const target = resolveSpecifier(file, specifier);
    const sourceFeature = /^src\/features\/([^/]+)\//.exec(relativeFile)?.[1];
    const targetFeature = /^src\/features\/([^/]+)\//.exec(target)?.[1];
    if (sourceFeature && targetFeature && sourceFeature !== targetFeature) rendererFeatureEdges.add(`${sourceFeature}->${targetFeature}`);
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
assert(!/require\(['"]\.\/repositories\/(?:workspace|operations|media|team-retouch)-repository/.test(mainSource),
  'the composition root must use domain public APIs rather than repository implementations');
for (const domain of ['workspace', 'file-operations', 'media', 'versioning']) {
  assert(fs.existsSync(path.join(root, 'electron', 'domains', domain, 'public.cjs')), `missing public API for ${domain}`);
}
assert(!fs.existsSync(path.join(root, 'electron', 'domains', 'team-retouch')) && !fs.existsSync(path.join(root, 'electron', 'repositories', 'team-retouch-repository.cjs')),
  'team-retouch business persistence must live only in its component service');

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

for (const [relativeFile, maximumLines] of Object.entries(ENTRY_FILE_BUDGETS)) {
  const lineCount = fs.readFileSync(path.join(root, relativeFile), 'utf8').split(/\r?\n/).length;
  assert(lineCount <= maximumLines, `${relativeFile} exceeded its ${maximumLines}-line composition budget (${lineCount})`);
}

console.log('Source package boundary tests passed.');
