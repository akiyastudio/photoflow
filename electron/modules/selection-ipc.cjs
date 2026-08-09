const registerSelectionIpc = ({ ipcMain, path, fs, selectionService, workspaceCatalogs }) => {
  const resolveRegisteredProject = requestedProjectPath => {
    const requested = path.resolve(String(requestedProjectPath || ''));
    for (const [workspaceRoot, catalog] of workspaceCatalogs) {
      for (const project of catalog.projects || []) {
        const projectRoot = path.resolve(workspaceRoot, project.relative_path);
        if (projectRoot.toLocaleLowerCase() !== requested.toLocaleLowerCase()) continue;
        if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error('项目文件夹不存在');
        const workspaceReal = fs.realpathSync.native(workspaceRoot);
        const projectReal = fs.realpathSync.native(projectRoot);
        const relative = path.relative(workspaceReal, projectReal);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('项目路径超出已注册工作区');
        return { workspaceRoot, projectName: project.name, projectRoot };
      }
    }
    throw new Error('项目未在当前工作区登记');
  };
  const requestFor = (projectPath, request) => ({ ...request, ...resolveRegisteredProject(projectPath) });
  const handle = method => async (_event, projectPath, request = {}) => {
    try {
      return await selectionService[method](requestFor(projectPath, request));
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  };

  ipcMain.handle('workspace-selection-filename-preflight', handle('preflightFilename'));
  ipcMain.handle('workspace-selection-source-folders', handle('listSourceFolders'));
  ipcMain.handle('workspace-selection-filename-execute', handle('executeFilename'));
  ipcMain.handle('workspace-selection-manual-preflight', handle('preflightManual'));
  ipcMain.handle('workspace-selection-manual-execute', handle('executeManual'));
  ipcMain.handle('workspace-selection-cancel', async (_event, operationId) => ({
    success: selectionService.cancel(String(operationId || '')),
  }));
};

module.exports = { registerSelectionIpc };
