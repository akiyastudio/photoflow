const fs = require('fs');
const path = require('path');

const createWorkspaceService = ({ repository, catalogs, statuses, assertInside, assertExistingInside }) => {
  const resolveRoot = workspacePath => {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) throw new Error('尚未选择工作目录');
    const requestedPath = path.resolve(workspacePath.trim());
    const isDriveRoot = requestedPath === path.parse(requestedPath).root;
    return isDriveRoot ? path.join(requestedPath, '照片流') : requestedPath;
  };

  const ensureRoot = workspacePath => {
    const root = resolveRoot(workspacePath);
    fs.mkdirSync(root, { recursive: true });
    return root;
  };

  const refreshCatalog = async root => {
    const response = await repository.load(root);
    const projects = Array.isArray(response.projects) ? response.projects : [];
    const catalog = { projects, byName: new Map(projects.map(project => [project.name.toLocaleLowerCase(), project])) };
    catalogs.set(root, catalog);
    return catalog;
  };

  const mutateCatalog = async (root, mutation, payload) => {
    const method = repository[mutation];
    if (typeof method !== 'function') throw new Error(`未知工作区变更：${mutation}`);
    await method(root, payload);
    return refreshCatalog(root);
  };

  const getProjectPath = (workspacePath, status, projectName) => {
    if (!statuses.includes(status)) throw new Error('无效的项目状态');
    const root = ensureRoot(workspacePath);
    const row = catalogs.get(root)?.byName.get(String(projectName).toLocaleLowerCase());
    const relativePath = row?.relative_path || projectName;
    const projectPath = path.resolve(root, relativePath);
    assertInside(root, projectPath, '项目路径');
    if (fs.existsSync(projectPath)) assertExistingInside(root, projectPath, '项目路径');
    return projectPath;
  };

  const cleanProjectName = value => String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

  return { resolveRoot, ensureRoot, refreshCatalog, mutateCatalog, getProjectPath, cleanProjectName };
};

module.exports = { createWorkspaceService };
