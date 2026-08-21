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
  const publishProgress = (event, progress) => event?.sender?.send?.('workspace-selection-progress', progress);
  const handle = (method, options = {}) => async (event, projectPath, request = {}) => {
    let trustedRequest;
    try {
      trustedRequest = requestFor(projectPath, request);
      trustedRequest.onProgress = progress => publishProgress(event, progress);
      const result = await selectionService[method](trustedRequest);
      if (options.publishTerminal) {
        const operationId = String(result?.operationId || trustedRequest.operationId || '');
        if (operationId) {
          const phase = result?.cancelled ? 'cancelled' : result?.success === false ? 'failed' : 'complete';
          const message = phase === 'complete' ? '选片文件处理完成' : phase === 'cancelled' ? '选片文件处理已取消' : result?.error || '选片文件处理失败';
          publishProgress(event, { operationId, phase, progress: phase === 'complete' ? 100 : 0, message, ...(phase === 'failed' ? { error: message } : {}) });
        }
      }
      return result;
    } catch (error) {
      if (options.publishTerminal) {
        const operationId = String(trustedRequest?.operationId || request?.operationId || '');
        if (operationId) {
          const message = error.message || String(error);
          publishProgress(event, { operationId, phase: 'failed', progress: 0, message, error: message });
        }
      }
      return { success: false, error: error.message || String(error) };
    }
  };

  ipcMain.handle('workspace-selection-filename-preflight', handle('preflightFilename'));
  ipcMain.handle('workspace-selection-source-folders', handle('listSourceFolders'));
  ipcMain.handle('workspace-selection-filename-execute', handle('executeFilename', { publishTerminal: true }));
  ipcMain.handle('workspace-selection-manual-preflight', handle('preflightManual'));
  ipcMain.handle('workspace-selection-manual-execute', handle('executeManual', { publishTerminal: true }));
  ipcMain.handle('workspace-selection-cancel', async (_event, operationId) => ({
    success: selectionService.cancel(String(operationId || '')),
  }));
};

module.exports = { registerSelectionIpc };
