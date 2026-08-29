const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const examplesRoot = path.join(repositoryRoot, 'examples');
const expectations = {
  'declarative-settings-v1': {
    capabilities: ['component.settings.v7'],
    permissions: ['component.settings'],
  },
  'hello-component': {
    capabilities: ['project.media.page.v7'],
    permissions: ['project.media.read'],
  },
  'host-api-v7': {
    capabilities: [],
    permissions: [],
  },
  'panel-only-v7': {
    capabilities: [],
    permissions: [],
  },
  'project-read-v7': {
    capabilities: ['project.files.page.v7'],
    permissions: ['project.files.read'],
  },
  'project-write-v7': {
    capabilities: ['project.media.ratings.write.v7'],
    permissions: ['project.media.ratings.write'],
  },
};

const exampleNames = fs.readdirSync(examplesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(examplesRoot, entry.name, 'component.json')))
  .map(entry => entry.name)
  .sort();

assert.deepEqual(exampleNames, Object.keys(expectations).sort(), 'examples/README.md and the example contract test must cover every component example');

for (const name of exampleNames) {
  const root = path.join(examplesRoot, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
  const descriptor = parseComponentHostManifest(manifest, root);
  const expectation = expectations[name];

  assert.deepEqual(descriptor.service.capabilities, expectation.capabilities, `${name} declares only its documented Host capabilities`);
  assert.deepEqual(descriptor.service.permissions, expectation.permissions, `${name} declares only the matching permissions`);
  assert(fs.existsSync(path.join(root, 'service.cjs')), `${name} includes its service entrypoint`);
  assert(fs.existsSync(path.join(root, 'ui', 'index.html')), `${name} includes its UI entrypoint`);

  const serviceSource = fs.readFileSync(path.join(root, 'service.cjs'), 'utf8');
  for (const method of descriptor.service.rpcMethods) {
    assert(serviceSource.includes(method), `${name} implements declared RPC ${method}`);
  }
}

const examplesReadme = fs.readFileSync(path.join(examplesRoot, 'README.md'), 'utf8');
for (const name of exampleNames) assert(examplesReadme.includes(`\`${name}\``), `examples/README.md documents ${name}`);

console.log('Component example manifests, least-privilege declarations, entrypoints, RPCs, and index passed');
