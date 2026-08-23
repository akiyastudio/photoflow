const path = require('path');

const PAGE_KEY_SEPARATOR = '\u001f';
const normalizeIdentity = value => String(value || '').trim().replace(/\\/g, '/').toLocaleLowerCase();
const componentPageKey = ({ componentId, workspacePath, projectId }) => [componentId, normalizeIdentity(workspacePath), String(projectId || '').trim()].join(PAGE_KEY_SEPARATOR);
const validBounds = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))
  && value.width >= 0 && value.height >= 0 && value.width <= 20000 && value.height <= 20000;

class ComponentViewManager {
  constructor({ WebContentsView, mainWindow, registry, preloadPath, ipcMain, serviceManager = null, writeLog = () => undefined }) {
    this.WebContentsView = WebContentsView;
    this.mainWindow = mainWindow;
    this.registry = registry;
    this.preloadPath = preloadPath;
    this.ipcMain = ipcMain;
    this.writeLog = writeLog;
    this.serviceManager = serviceManager;
    this.instances = new Map();
    this.senderBindings = new Map();
    this.rpcMethods = new Map();
    this.registerComponentSdkIpc();
  }

  registerComponentSdkIpc() {
    this.ipcMain.handle('component-sdk:get-context', event => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      const { workspacePath: _privateWorkspacePath, ...publicContext } = instance.context;
      return publicContext;
    });
    this.ipcMain.handle('component-sdk:rpc', (event, method, payload) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      const normalizedMethod = String(method || '');
      const registration = this.rpcMethods.get(normalizedMethod);
      if (registration?.componentId === instance.context.componentId) return registration.handler(event, payload, instance.context);
      if (this.serviceManager?.supports(instance.context.componentId, normalizedMethod)) {
        return this.serviceManager.invoke(instance.context.componentId, normalizedMethod, payload, instance.context);
      }
      throw new Error(`Unknown component RPC method: ${normalizedMethod}`);
    });
  }

  registerRpcMethod(method, handler, componentId) {
    if (this.rpcMethods.has(method)) throw new Error(`Duplicate component RPC method: ${method}`);
    if (!componentId) throw new Error(`Component RPC method must declare an owner: ${method}`);
    this.rpcMethods.set(method, { componentId, handler });
  }

  listToolbarActions() {
    return this.registry.list().map(item => ({
      componentId: item.componentId,
      componentVersion: item.componentVersion,
      contractVersion: item.contractVersion,
      hostApiVersion: item.hostApiVersion,
      actionId: item.toolbarAction.id,
      label: item.toolbarAction.label,
      pageId: item.fullPage.id,
      pageTitle: item.fullPage.title,
    }));
  }

  async open(request) {
    const descriptor = this.registry.resolve(request.componentId);
    if (!descriptor || descriptor.fullPage.id !== request.pageId) throw new Error('Unknown component page');
    const key = componentPageKey(request);
    const existing = this.instances.get(key);
    if (existing) { this.activate(existing.instanceId); return this.publicInstance(existing); }
    const instanceId = `component-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const view = new this.WebContentsView({ webPreferences: {
      preload: this.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    } });
    const instance = {
      key, instanceId, view, descriptor,
      context: Object.freeze({
        componentId: descriptor.componentId,
        componentVersion: descriptor.componentVersion,
        workspacePath: String(request.workspacePath || ''),
        projectId: String(request.projectId || ''),
        projectName: String(request.projectName || ''),
        projectStatus: String(request.projectStatus || ''),
      }),
    };
    this.instances.set(key, instance);
    const senderId = view.webContents.id;
    this.senderBindings.set(senderId, instance);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.once('destroyed', () => {
      this.senderBindings.delete(senderId);
      if (this.instances.get(key) === instance) this.instances.delete(key);
    });
    this.mainWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    try { await view.webContents.loadFile(descriptor.fullPage.entry); }
    catch (error) { this.close(instanceId); throw error; }
    this.activate(instanceId);
    return this.publicInstance(instance);
  }

  publicInstance(instance) {
    return { instanceId: instance.instanceId, componentId: instance.descriptor.componentId, pageId: instance.descriptor.fullPage.id, pageTitle: instance.descriptor.fullPage.title };
  }

  activate(instanceId) {
    let found = false;
    for (const instance of this.instances.values()) {
      const active = instance.instanceId === instanceId;
      found ||= active;
      instance.view.setVisible(active);
      instance.view.webContents.send(active ? 'component-sdk:activate' : 'component-sdk:deactivate');
    }
    return found;
  }

  setBounds(instanceId, bounds) {
    if (!validBounds(bounds)) throw new Error('Invalid component page bounds');
    const instance = [...this.instances.values()].find(item => item.instanceId === instanceId);
    if (!instance) return false;
    instance.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    return true;
  }

  close(instanceId) {
    const instance = [...this.instances.values()].find(item => item.instanceId === instanceId);
    if (!instance) return false;
    this.instances.delete(instance.key);
    this.senderBindings.delete(instance.view.webContents.id);
    try { this.mainWindow.contentView.removeChildView(instance.view); } catch { /* already detached */ }
    if (!instance.view.webContents.isDestroyed()) instance.view.webContents.close({ waitForBeforeUnload: false });
    return true;
  }

  closeProject(workspacePath, projectId) {
    const normalizedWorkspace = normalizeIdentity(workspacePath);
    const ids = [...this.instances.values()].filter(instance => normalizeIdentity(instance.context.workspacePath) === normalizedWorkspace && instance.context.projectId === String(projectId)).map(instance => instance.instanceId);
    ids.forEach(id => this.close(id));
    return ids.length;
  }

  destroy() { [...this.instances.values()].forEach(instance => this.close(instance.instanceId)); }
}

module.exports = { ComponentViewManager, componentPageKey, validBounds };
