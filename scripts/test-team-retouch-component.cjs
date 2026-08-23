const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { COMPONENT_RPC_METHODS, sanitizePayload, stripReturnPaths, stripWorkspacePaths } = require('../electron/component-rpc-contract.cjs');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');

const root = path.resolve(__dirname, '..');
const rendererOutput = path.join(root, 'artifacts', 'component-renderers', 'team-retouch');
const template = JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'team-retouch', 'component.template.json'), 'utf8'));
const builder = fs.readFileSync(path.join(root, 'scripts', 'build-components.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'src', 'features', 'settings', 'SettingsFeature.tsx'), 'utf8');
const versionsIpc = fs.readFileSync(path.join(root, 'electron', 'modules', 'versions-ipc.cjs'), 'utf8');
const systemIpc = fs.readFileSync(path.join(root, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');

assert(fs.existsSync(path.join(rendererOutput, 'index.html')), 'independent team-retouch renderer must be built before this test');
const outputFiles = fs.readdirSync(path.join(rendererOutput, 'assets'));
assert(outputFiles.some(file => file.endsWith('.js')) && outputFiles.some(file => file.endsWith('.css')), 'renderer output must include self-contained JS and CSS assets');
const outputText = [fs.readFileSync(path.join(rendererOutput, 'index.html'), 'utf8'), ...outputFiles.filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(rendererOutput, 'assets', file), 'utf8'))].join('\n');
assert(!outputText.includes('/src/') && !outputText.includes('src/components/TeamRetouch') && !outputText.includes('electronAPI'), 'production renderer output must not reference repository or application renderer sources');
assert(template.componentHost.contributions.some(item => item.type === 'component.fullPage' && item.entry === 'ui/index.html'));
assert(template.requiredFiles.includes('ui/index.html') && template.requiredFiles.includes('ui/team-retouch.svg'), 'installation must reject a component missing its renderer or icon');
assert(template.requiredFiles.includes('service.cjs'), 'installation must reject a component missing its backend service');
assert(template.requiredFiles.includes('workflow-generation.cjs') && template.requiredFiles.includes('workflow-artifact.cjs'), 'installation must reject a component missing workflow orchestration modules');
assert.deepEqual(template.componentHost.service.rpcMethods, [
  'team.project.get.v1', 'team.project.register.v1', 'team.project.remove-photo.v1',
  'team.identity.save.v1', 'team.identity.assign.v1', 'team.identity.confirm-group.v1', 'team.identity.delete.v1',
  'team.person.exclude.v1', 'team.patch.get.v1', 'team.patch.detect.v1', 'team.patch.detect-batch.v1',
  'team.patch.update.v1', 'team.patch.delete.v1', 'team.patch.cleanup.v1', 'team.patch.upload.v1',
  'team.patch.remove-upload.v1', 'team.patch.merge.v1',
  'team.identity.similarities.v1', 'team.identity.suggest.v1', 'team.identity.complete.v1',
  'team.media.authorize.v1', 'team.patch.open.v1', 'team.workflow.settings.save.v1',
  'team.workflow.status.v1', 'team.workflow.cancel.v1', 'team.workflow.generate.v1',
  'team.workflow.export.v1', 'team.workflow.open-export.v1',
  'team.workflow.return-review.get.v1', 'team.workflow.return-review.discard.v1', 'team.workflow.return-review.ignore.v1',
  'team.workflow.return-batch.v1', 'team.workflow.return-confirm.v1',
  'team.patch.select-returns.v1', 'team.patch.return-batch.v1',
  'team.workflow.artifact.migrate.v1',
  'component.settings.get.v1', 'component.settings.update.v1',
  'component.advanced.preflight.v1', 'component.advanced.install.v1', 'component.advanced.uninstall.v1',
]);
assert(template.componentHost.service.rpcMethods.every(method => !COMPONENT_RPC_METHODS[method]), 'service-owned routes must not retain legacy RPC mappings');
for (const channel of [
  'workspace-team-identity-similarities', 'workspace-team-workflow-settings-save',
  'workspace-team-identities-suggest', 'workspace-team-identity-complete',
  'workspace-team-media-authorize', 'workspace-team-patch-open-by-id', 'workspace-team-patch-open', 'workspace-team-patch-open-folder',
  'workspace-team-person-exclude', 'workspace-team-project-remove-photo', 'workspace-team-patches',
  'workspace-team-patch-detect', 'workspace-team-patch-detect-batch', 'workspace-team-patch-update',
  'workspace-team-patch-delete', 'workspace-team-patch-cleanup', 'workspace-team-patch-upload',
  'workspace-team-patch-remove-upload', 'workspace-team-patch-merge',
  'workspace-team-workflow-status', 'workspace-team-workflow-cancel', 'workspace-team-workflow-generate',
  'workspace-team-identity-export', 'workspace-team-identity-open-export',
  'workspace-team-workflow-return-review-get', 'workspace-team-workflow-return-review-discard', 'workspace-team-workflow-return-review-ignore',
  'workspace-team-workflow-return-batch', 'workspace-team-workflow-return-confirm',
  'workspace-team-patch-select-returns', 'workspace-team-patch-return-batch',
]) assert(!versionsIpc.includes(`ipcMain.handle('${channel}'`), `${channel} must have exactly one component-service writer`);
for (const channel of ['component-settings-get', 'component-settings-update']) assert(!systemIpc.includes(`ipcMain.handle('${channel}'`), `${channel} must not retain a system IPC route`);
for (const capability of ['component.storage.v1', 'project.media.read.v1', 'project.output.authorize.v1', 'version.register.v1', 'tasks.report.v1', 'dialogs.open.v1', 'project.media.access.v1', 'project.identity.complete.v1', 'component.settings.v1', 'component.lifecycle.v1']) assert(template.componentHost.service.capabilities.includes(capability), `${capability} must be manifest-granted`);
assert(!template.componentHost.service.capabilities.includes('component.runtime.v1') && template.componentHost.service.runtimeActions.length === 0, 'team algorithms must execute inside the component service instead of a host runtime action');
assert.equal((versionsIpc.match(/ipcMain\.handle\('workspace-team-/g) || []).length, 0, 'versions IPC must not register any legacy team handler');
assert(!versionsIpc.includes('shell.openPath'), 'versions IPC must not retain arbitrary team path-opening code');
assert(builder.indexOf('buildRenderer(id)') < builder.indexOf("if (id === 'team-retouch' && !probeModule('onnxruntime'))"), 'renderer must build before native runtime packaging starts');
assert(builder.includes('fs.cpSync(rendererOutput, uiRoot, { recursive: true })') && builder.includes("path.join(target, 'ui')"), 'component package must receive the renderer output');
assert(!preload.includes('workspace-team-') && !workspace.includes('TeamRetouch') && !workspace.includes('团片协作') && !settings.includes("activeSection === 'team-retouch'"), 'application renderer boundaries must remain free of legacy team UI and APIs');
assert(Object.keys(COMPONENT_RPC_METHODS).every(method => method.endsWith('.v1')), 'every component RPC capability must be explicitly versioned');
assert.deepEqual(sanitizePayload({ relativePaths: ['a.jpg'], workspacePath: 'C:/escape', channel: 'arbitrary' }, ['relativePaths']), { relativePaths: ['a.jpg'] }, 'unknown fields, workspace identities, and arbitrary channels must be discarded');
assert.throws(() => sanitizePayload('bad', []), /payload must be an object/);
assert.throws(() => sanitizePayload({ value: 'x'.repeat(2 * 1024 * 1024) }, ['value']), /too large/);
for (const method of ['team.media.authorize.v1', 'team.patch.open.v1']) assert(template.componentHost.service.rpcMethods.includes(method) && !COMPONENT_RPC_METHODS[method], `${method} must be service-owned without a legacy mapping`);
const safeWorkspace = stripWorkspacePaths({ photos: [{ photoId: 'p1', sourcePath: 'C:/secret.jpg', tasks: [{ id: 't1', patchPath: 'C:/patch.png', editedPatchPath: 'C:/return.png' }] }] });
assert(!JSON.stringify(safeWorkspace).includes('C:/'), 'component workspace responses must not disclose host file paths');
const safeReview = stripReturnPaths({ path: 'C:/return.jpg', matches: [{ returnId: 'r1', path: 'C:/return.jpg', mediaPath: 'media-token:secret', alternatives: [{ taskId: 't1', patchPath: 'C:/patch.png' }] }] });
assert(!JSON.stringify(safeReview).includes('C:/') && !JSON.stringify(safeReview).includes('media-token:'), 'review responses must expose only IDs and scores');
const rendererSource = fs.readFileSync(path.join(root, 'extensions', 'team-retouch', 'renderer', 'src', 'main.tsx'), 'utf8');
assert(rendererSource.includes("rpc<Json>('team.identity.similarities.v1')") && rendererSource.includes('data-crop-handle') && rendererSource.includes("'difference', '差异'") && rendererSource.includes("'blink', '闪烁'"), 'independent renderer must contain ranked identity, 8-handle crop, and five-mode comparison behavior');
assert(!rendererSource.includes('returnedPath:') && !rendererSource.includes('patchPath: subject.task') && !rendererSource.includes('window.electronAPI'), 'renderer must never submit paths or access the application preload');
const serviceSource = fs.readFileSync(path.join(root, 'extensions', 'team-retouch', 'service.cjs'), 'utf8');
assert(serviceSource.includes('if (host?.cancelled) job.cancelled = true') && serviceSource.includes('.photoflow-workflow-checkpoint.json'), 'task-center cancellation and checkpoint recovery must be enforced by the component service');
assert(serviceSource.includes('await fs.promises.rename(backupDirectory, scope.outputDirectory)') && serviceSource.includes("action: 'cleanup-workflow-backup'"), 'workflow replacement must roll back crashes and defer committed backup cleanup');

const staged = fs.mkdtempSync(path.join(require('os').tmpdir(), 'photoflow-team-component-'));
try {
  fs.cpSync(rendererOutput, path.join(staged, 'ui'), { recursive: true });
  fs.copyFileSync(path.join(root, 'extensions', 'team-retouch', 'renderer', 'team-retouch.svg'), path.join(staged, 'ui', 'team-retouch.svg'));
  fs.copyFileSync(path.join(root, 'extensions', 'team-retouch', 'service.cjs'), path.join(staged, 'service.cjs'));
  fs.copyFileSync(path.join(root, 'extensions', 'team-retouch', 'workflow-generation.cjs'), path.join(staged, 'workflow-generation.cjs'));
  fs.copyFileSync(path.join(root, 'extensions', 'team-retouch', 'workflow-artifact.cjs'), path.join(staged, 'workflow-artifact.cjs'));
  fs.writeFileSync(path.join(staged, 'component.json'), JSON.stringify(template));
  const descriptor = parseComponentHostManifest(template, staged);
  assert.equal(descriptor.componentId, 'team-retouch');
  assert.equal(descriptor.fullPage.entry, path.join(staged, 'ui', 'index.html'));
  assert.equal(descriptor.service.entry, path.join(staged, 'service.cjs'));
  assert.equal(descriptor.advancedRuntime.apiVersion, 1);
  assert.deepEqual(descriptor.advancedRuntime.compatibleLegacyComponentVersions, ['26.7.30.1']);
  assert.deepEqual(descriptor.service.runtimeActions, []);
  assert.equal(descriptor.service.lifecycleActions['advanced.install'].sha256.length, 64);
} finally {
  fs.rmSync(staged, { recursive: true, force: true });
}

console.log('Team-retouch component boundary tests passed');
