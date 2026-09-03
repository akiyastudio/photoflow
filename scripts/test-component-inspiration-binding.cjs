const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createComponentContentBinding } = require('../electron/services/component-content-binding.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-inspiration-'));
const workspaceRoot = path.join(root, 'workspace');
const inspirationRoot = path.join(root, 'inspiration');
fs.mkdirSync(workspaceRoot);
fs.mkdirSync(inspirationRoot);

let config = { workspacePath: workspaceRoot, inspirationLibrary: { rootPath: inspirationRoot } };
const project = { id: 'project-1', name: 'Project', status: '后期中' };
const binding = createComponentContentBinding({
  path,
  readSavedConfig: () => config,
  ensureWorkspace: candidate => {
    assert.equal(path.resolve(candidate), path.resolve(workspaceRoot));
    return path.resolve(candidate);
  },
  getBoundProject: (_workspace, name) => name === project.name ? project : null,
  getProjectPath: (workspace, status, name) => path.join(workspace, status, name),
});

try {
  const opened = binding.resolveOpenRequest({
    contentKind: 'inspiration',
    workspacePath: 'C:/forged-workspace',
    projectId: 'forged-project',
    projectName: 'forged-name',
    projectStatus: 'forged-status',
  });
  assert.equal(opened.contentKind, 'inspiration');
  assert.equal(opened.workspacePath, path.resolve(workspaceRoot));
  assert.equal(opened.contentRootPath, path.resolve(inspirationRoot));
  assert.equal(opened.projectId, `inspiration:${inspirationRoot}`);

  const resolvedInspiration = binding.resolve(opened);
  assert.equal(resolvedInspiration.contentKind, 'inspiration');
  assert.equal(resolvedInspiration.projectRoot, path.resolve(inspirationRoot));

  const resolvedProject = binding.resolve({ contentKind: 'project', workspacePath: workspaceRoot, projectId: project.id, projectName: project.name, projectStatus: project.status });
  assert.equal(resolvedProject.contentKind, 'project');
  assert.equal(resolvedProject.projectRoot, path.join(workspaceRoot, project.status, project.name));

  config = { ...config, inspirationLibrary: { rootPath: path.join(root, 'replacement') } };
  assert.throws(() => binding.resolve(opened), error => error?.code === 'COMPONENT_HOST_PERMISSION_DENIED');
  console.log('Component inspiration binding tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
