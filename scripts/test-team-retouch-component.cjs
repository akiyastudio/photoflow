const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { COMPONENT_RPC_METHODS, sanitizePayload } = require('../electron/component-rpc-contract.cjs');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');

const root = path.resolve(__dirname, '..');
const rendererOutput = path.join(root, 'artifacts', 'component-renderers', 'team-retouch');
const template = JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'team-retouch', 'component.template.json'), 'utf8'));
const builder = fs.readFileSync(path.join(root, 'scripts', 'build-components.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'src', 'features', 'settings', 'SettingsFeature.tsx'), 'utf8');

assert(fs.existsSync(path.join(rendererOutput, 'index.html')), 'independent team-retouch renderer must be built before this test');
const outputFiles = fs.readdirSync(path.join(rendererOutput, 'assets'));
assert(outputFiles.some(file => file.endsWith('.js')) && outputFiles.some(file => file.endsWith('.css')), 'renderer output must include self-contained JS and CSS assets');
const outputText = [fs.readFileSync(path.join(rendererOutput, 'index.html'), 'utf8'), ...outputFiles.filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(rendererOutput, 'assets', file), 'utf8'))].join('\n');
assert(!outputText.includes('/src/') && !outputText.includes('src/components/TeamRetouch') && !outputText.includes('electronAPI'), 'production renderer output must not reference repository or application renderer sources');
assert(template.componentHost.contributions.some(item => item.type === 'component.fullPage' && item.entry === 'ui/index.html'));
assert(template.requiredFiles.includes('ui/index.html') && template.requiredFiles.includes('ui/team-retouch.svg'), 'installation must reject a component missing its renderer or icon');
assert(template.requiredFiles.includes('service.cjs'), 'installation must reject a component missing its backend service');
assert.deepEqual(template.componentHost.service.rpcMethods, [
  'team.project.get.v1', 'team.project.register.v1',
  'team.identity.save.v1', 'team.identity.assign.v1', 'team.identity.confirm-group.v1', 'team.identity.delete.v1',
]);
assert(template.componentHost.service.rpcMethods.every(method => !COMPONENT_RPC_METHODS[method]), 'service-owned routes must not retain legacy RPC mappings');
assert(template.componentHost.service.capabilities.includes('component.storage.v1') && template.componentHost.service.capabilities.includes('project.media.read.v1'));
assert(builder.indexOf('buildRenderer(id)') < builder.indexOf("if (id === 'team-retouch' && !probeModule('onnxruntime'))"), 'renderer must build before native runtime packaging starts');
assert(builder.includes('fs.cpSync(rendererOutput, uiRoot, { recursive: true })') && builder.includes("path.join(target, 'ui')"), 'component package must receive the renderer output');
assert(!preload.includes('workspace-team-') && !workspace.includes('TeamRetouch') && !workspace.includes('团片协作') && !settings.includes("activeSection === 'team-retouch'"), 'application renderer boundaries must remain free of legacy team UI and APIs');
assert(Object.keys(COMPONENT_RPC_METHODS).every(method => method.endsWith('.v1')), 'every component RPC capability must be explicitly versioned');
assert.deepEqual(sanitizePayload({ relativePaths: ['a.jpg'], workspacePath: 'C:/escape', channel: 'arbitrary' }, ['relativePaths']), { relativePaths: ['a.jpg'] }, 'unknown fields, workspace identities, and arbitrary channels must be discarded');
assert.throws(() => sanitizePayload('bad', []), /payload must be an object/);
assert.throws(() => sanitizePayload({ value: 'x'.repeat(2 * 1024 * 1024) }, ['value']), /too large/);

const staged = fs.mkdtempSync(path.join(require('os').tmpdir(), 'photoflow-team-component-'));
try {
  fs.cpSync(rendererOutput, path.join(staged, 'ui'), { recursive: true });
  fs.copyFileSync(path.join(root, 'extensions', 'team-retouch', 'renderer', 'team-retouch.svg'), path.join(staged, 'ui', 'team-retouch.svg'));
  fs.copyFileSync(path.join(root, 'extensions', 'team-retouch', 'service.cjs'), path.join(staged, 'service.cjs'));
  fs.writeFileSync(path.join(staged, 'component.json'), JSON.stringify(template));
  const descriptor = parseComponentHostManifest(template, staged);
  assert.equal(descriptor.componentId, 'team-retouch');
  assert.equal(descriptor.fullPage.entry, path.join(staged, 'ui', 'index.html'));
  assert.equal(descriptor.service.entry, path.join(staged, 'service.cjs'));
} finally {
  fs.rmSync(staged, { recursive: true, force: true });
}

console.log('Team-retouch component boundary tests passed');
