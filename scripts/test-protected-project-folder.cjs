const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProtectedProjectFolderRegistry } = require('../electron/services/protected-project-folder.cjs');

const policyName = 'Component Owned Output';
const registry = createProtectedProjectFolderRegistry({
  descriptors: [{ service: { projectFolders: [{ name: policyName, protectFromGenericRename: true, reserveProgressRelocationName: true }] } }],
});
assert.equal(registry.isProtectedProjectFolderName(policyName.toLocaleLowerCase()), true);
assert.equal(registry.progressRelocationReservedNames().includes(policyName.toLocaleLowerCase()), true);

const relocationOnly = createProtectedProjectFolderRegistry({
  descriptors: [{ service: { projectFolders: [{ name: 'Relocation Only', protectFromGenericRename: false, reserveProgressRelocationName: true }] } }],
});
assert.equal(relocationOnly.isProtectedProjectFolderName('Relocation Only'), false);
assert.equal(relocationOnly.progressRelocationReservedNames().includes('relocation only'), true);

let dynamicDescriptors = [];
const dynamicRegistry = createProtectedProjectFolderRegistry({ descriptorProvider: () => dynamicDescriptors });
assert.equal(dynamicRegistry.isProtectedProjectFolderName('Installed Later'), false);
dynamicDescriptors = [{ service: { projectFolders: [{ name: 'Installed Later', protectFromGenericRename: true }] } }];
assert.equal(dynamicRegistry.isProtectedProjectFolderName('Installed Later'), true, 'runtime installs are reflected through the verified descriptor provider');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'project-folder-policy-'));
try {
  const projectRoot = path.join(sandbox, 'Project');
  const protectedFolder = path.join(projectRoot, policyName);
  const nestedFolder = path.join(projectRoot, 'nested', policyName);
  fs.mkdirSync(protectedFolder, { recursive: true });
  fs.mkdirSync(nestedFolder, { recursive: true });
  assert.equal(registry.isProtectedProjectFolderPath({ fs, path, projectRoot, candidate: protectedFolder }), true);
  assert.equal(registry.isProtectedProjectFolderPath({ fs, path, projectRoot, candidate: nestedFolder }), false, 'only declared top-level project folders are protected');
  assert.equal(registry.isProtectedProjectFolderPath({ fs, path, projectRoot, candidate: path.join(projectRoot, 'missing') }), false);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('Protected project folder registry tests passed.');
