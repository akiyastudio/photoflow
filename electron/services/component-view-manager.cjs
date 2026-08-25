const path = require('path');
const { LEGACY_VIEW_EVENT_CHANNELS } = require('../compatibility/component-v1-metadata.cjs');

const PAGE_KEY_SEPARATOR = '\u001f';
const normalizeIdentity = value => String(value || '').trim().replace(/\\/g, '/').toLocaleLowerCase();
const normalizeResolvedTheme = value => value === 'dark' ? 'dark' : 'light';
const normalizeRelativePath = (value, field = 'component scope') => {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (raw.length > 1024 || /^(?:[a-z]:|\/)/i.test(raw)) throw new Error(`Invalid ${field}`);
  const normalized = raw.replace(/\/+$/g, '');
  if (normalized.split('/').some(part => part === '..')) throw new Error(`Invalid ${field}`);
  return normalized;
};
const normalizeOpenScope = request => {
  const scopeRelativePath = normalizeRelativePath(request.scopeRelativePath, 'component scope');
  const selected = Array.isArray(request.selectedRelativePaths) ? request.selectedRelativePaths : [];
  if (selected.length > 10000) throw new Error('Too many component selected paths');
  const selectedRelativePaths = [...new Set(selected.map(value => normalizeRelativePath(value, 'component selected path')).filter(Boolean))];
  if (scopeRelativePath && selectedRelativePaths.some(value => value !== scopeRelativePath && !value.startsWith(`${scopeRelativePath}/`))) throw new Error('Component selection escapes its folder scope');
  const sourcePageId = String(request.sourcePageId || '').trim();
  if (sourcePageId.length > 160) throw new Error('Invalid component source page');
  return { scopeRelativePath, selectedRelativePaths, sourcePageId };
};
const componentPageKey = ({ componentId, workspacePath, projectId }) => ['project', componentId, normalizeIdentity(workspacePath), String(projectId || '').trim()].join(PAGE_KEY_SEPARATOR);
const componentSettingsPageKey = ({ componentId, pageId }) => ['application.settings', componentId, String(pageId || '').trim()].join(PAGE_KEY_SEPARATOR);
const validBounds = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))
  && value.width >= 0 && value.height >= 0 && value.width <= 20000 && value.height <= 20000;
const selectComponentPreload = (descriptor, { core, compatibilityV1 }) => {
  const contractVersion = Number(descriptor?.contractVersion);
  const hostApiVersion = Number(descriptor?.hostApiVersion);
  if (contractVersion === 1 && hostApiVersion >= 1) return compatibilityV1;
  if (contractVersion === 2 && hostApiVersion >= 2) return core;
  throw new Error(`Unsupported component preload contract: contract=${contractVersion || 'unknown'} hostApi=${hostApiVersion || 'unknown'}`);
};
const diagnosticToken = value => {
  const token = String(value || '').trim();
  return /^[a-z0-9_.:-]{1,80}$/i.test(token) ? token : 'unknown';
};

class ComponentViewManager {
  constructor({ WebContentsView, mainWindow, registry, preloadPath, compatibilityPreloadPath = path.join(path.dirname(preloadPath), 'compatibility', 'component-preload-v1.cjs'), ipcMain, serviceManager = null, writeLog = () => undefined }) {
    this.WebContentsView = WebContentsView;
    this.mainWindow = mainWindow;
    this.registry = registry;
    this.preloadPath = preloadPath;
    this.compatibilityPreloadPath = compatibilityPreloadPath;
    this.ipcMain = ipcMain;
    this.writeLog = writeLog;
    this.serviceManager = serviceManager;
    this.instances = new Map();
    this.instancesById = new Map();
    this.senderBindings = new Map();
    this.rpcMethods = new Map();
    this.resolvedTheme = 'light';
    this.activeInstanceId = '';
    this.hostSurfaceState = { rendererToken: '', revision: -1, suspended: false };
    this.registerComponentSdkIpc();
  }

  registerComponentSdkIpc() {
    this.ipcMain.handle('component-sdk:get-context', event => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      return this.publicContext(instance);
    });
    this.ipcMain.handle('component-sdk:rpc', (event, method, payload) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      const normalizedMethod = String(method || '');
      if (instance.context.surface === 'application.settings') {
        if (!instance.settingsPage?.rpcMethods.includes(normalizedMethod)) throw new Error(`Component RPC method is not allowed on the application settings surface: ${normalizedMethod}`);
        if (!this.serviceManager?.supports(instance.context.componentId, normalizedMethod)) throw new Error(`Unknown component service RPC method: ${normalizedMethod}`);
        return this.serviceManager.invoke(instance.context.componentId, normalizedMethod, payload, instance.context);
      }
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
      ...(item.icon ? { iconUrl: `photoflow-component://icon/${encodeURIComponent(item.componentId)}?v=${encodeURIComponent(item.componentVersion)}` } : {}),
    }));
  }

  listSettingsPages() {
    return this.registry.list().flatMap(item => (item.settingsPages || []).map(page => ({
      componentId: item.componentId,
      componentVersion: item.componentVersion,
      contractVersion: item.contractVersion,
      hostApiVersion: item.hostApiVersion,
      pageId: page.id,
      label: page.label,
      pageTitle: page.title,
      ...(item.icon ? { iconUrl: `photoflow-component://icon/${encodeURIComponent(item.componentId)}?v=${encodeURIComponent(item.componentVersion)}` } : {}),
    })));
  }

  async open(request) {
    return this.openSurface(request, 'project');
  }

  async openSettings(request) {
    return this.openSurface(request, 'application.settings');
  }

  releaseSettings(request) {
    const leaseId = String(request?.leaseId || '');
    const key = componentSettingsPageKey(request || {});
    const instance = this.instances.get(key);
    if (!instance || instance.context.surface !== 'application.settings' || !instance.settingsLeases?.delete(leaseId)) return false;
    const generation = ++instance.leaseGeneration;
    setImmediate(() => {
      if (this.instances.get(key) === instance && instance.leaseGeneration === generation && instance.settingsLeases.size === 0) this.close(instance.instanceId);
    });
    return true;
  }

  async openSurface(request, surface) {
    const descriptor = this.registry.resolve(request.componentId);
    const settingsPage = surface === 'application.settings' ? descriptor?.settingsPages?.find(page => page.id === request.pageId) : null;
    const page = surface === 'application.settings' ? settingsPage : descriptor?.fullPage;
    if (!descriptor || !page || page.id !== request.pageId) throw new Error('Unknown component page');
    const key = surface === 'application.settings' ? componentSettingsPageKey(request) : componentPageKey(request);
    const leaseId = surface === 'application.settings' ? String(request.leaseId || '') : '';
    if (surface === 'application.settings' && !/^[a-z0-9._:-]{8,160}$/i.test(leaseId)) throw new Error('Invalid component settings page lease');
    this.writeLog('info', 'Component page context bound', { componentId: request.componentId, surface, projectId: surface === 'project' ? String(request.projectId || '') : '', projectName: surface === 'project' ? String(request.projectName || '') : '', projectStatus: surface === 'project' ? String(request.projectStatus || '') : '', sourcePageId: surface === 'project' ? String(request.sourcePageId || '') : '' });
    let existing = this.instances.get(key);
    if (existing && (existing.descriptor.componentVersion !== descriptor.componentVersion || existing.page.entry !== page.entry)) {
      this.close(existing.instanceId);
      existing = null;
    }
    if (existing) {
      if (surface === 'application.settings') { existing.settingsLeases.add(leaseId); existing.leaseGeneration += 1; }
      await existing.readyPromise;
      if (this.instances.get(key) !== existing || existing.view.webContents.isDestroyed()) throw new Error('Component page open was superseded');
      if (surface === 'application.settings' && !existing.settingsLeases.has(leaseId)) throw new Error('Component settings page lease was released');
      existing.context = Object.freeze({
        ...existing.context,
        componentVersion: descriptor.componentVersion,
        projectName: surface === 'project' ? String(request.projectName || '') : '',
        projectStatus: surface === 'project' ? String(request.projectStatus || '') : '',
        ...(surface === 'project' ? normalizeOpenScope(request) : { scopeRelativePath: '', selectedRelativePaths: [], sourcePageId: '' }),
      });
      if (!existing.view.webContents.isDestroyed()) existing.view.webContents.send('component-sdk:context-changed', this.publicContext(existing));
      this.activate(existing.instanceId); return this.publicInstance(existing, leaseId);
    }
    const instanceId = `component-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const selectedPreloadPath = selectComponentPreload(descriptor, { core: this.preloadPath, compatibilityV1: this.compatibilityPreloadPath });
    const view = new this.WebContentsView({ webPreferences: {
      preload: selectedPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    } });
    const instance = {
      key, instanceId, view, descriptor, page, settingsPage,
      readyPromise: null,
      settingsLeases: new Set(surface === 'application.settings' ? [leaseId] : []),
      leaseGeneration: 1,
      logicalActive: false,
      context: Object.freeze({
        componentId: descriptor.componentId,
        componentVersion: descriptor.componentVersion,
        surface,
        workspacePath: surface === 'project' ? String(request.workspacePath || '') : '',
        projectId: surface === 'project' ? String(request.projectId || '') : '',
        projectName: surface === 'project' ? String(request.projectName || '') : '',
        projectStatus: surface === 'project' ? String(request.projectStatus || '') : '',
        ...(surface === 'project' ? normalizeOpenScope(request) : { scopeRelativePath: '', selectedRelativePaths: [], sourcePageId: '' }),
        eventSender: view.webContents,
        emitComponentEvent: (topic, payload) => {
          const channel = LEGACY_VIEW_EVENT_CHANNELS[String(topic || '')];
          if (channel && !view.webContents.isDestroyed()) view.webContents.send(channel, payload);
          if (descriptor.service?.events?.includes(String(topic || '')) && !view.webContents.isDestroyed()) {
            view.webContents.send('component-sdk:event', { topic: String(topic), payload });
          }
        },
      }),
    };
    this.instances.set(key, instance);
    this.instancesById.set(instanceId, instance);
    const senderId = view.webContents.id;
    this.senderBindings.set(senderId, instance);
    const diagnostic = (level, message, details = {}) => this.writeLog(level, message, {
      componentId: descriptor.componentId,
      contractVersion: descriptor.contractVersion,
      hostApiVersion: descriptor.hostApiVersion,
      ...details,
    });
    view.webContents.on('preload-error', (_event, _preloadPath, error) => diagnostic('error', 'Component preload failed', {
      errorName: diagnosticToken(error?.name), errorCode: diagnosticToken(error?.code), messageLength: Math.min(String(error?.message || '').length, 10000),
    }));
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame !== false) diagnostic('error', 'Component page failed to load', { errorCode, errorDescription: diagnosticToken(errorDescription) });
    });
    view.webContents.on('render-process-gone', (_event, details) => diagnostic('error', 'Component renderer process exited', {
      reason: diagnosticToken(details?.reason), exitCode: Number(details?.exitCode) || 0,
    }));
    view.webContents.on('console-message', (_event, detailsOrLevel, message, lineNumber) => {
      const details = typeof detailsOrLevel === 'object' ? detailsOrLevel : { level: detailsOrLevel, message, lineNumber };
      if (!['error', 3].includes(details?.level)) return;
      diagnostic('error', 'Component renderer console error', { lineNumber: Number(details?.lineNumber) || 0, messageLength: Math.min(String(details?.message || '').length, 10000) });
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.once('destroyed', () => {
      this.senderBindings.delete(senderId);
      if (this.instances.get(key) === instance) this.instances.delete(key);
      if (this.instancesById.get(instanceId) === instance) this.instancesById.delete(instanceId);
    });
    this.mainWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    instance.readyPromise = Promise.resolve().then(() => view.webContents.loadFile(page.entry)).then(() => {
      if (this.instances.get(key) !== instance || view.webContents.isDestroyed()) throw new Error('Component page open was superseded');
      return instance;
    });
    try { await instance.readyPromise; }
    catch (error) { if (this.instances.get(key) === instance) this.close(instanceId); throw error; }
    if (surface === 'application.settings' && !instance.settingsLeases.has(leaseId)) throw new Error('Component settings page lease was released');
    this.activate(instanceId);
    return this.publicInstance(instance, leaseId);
  }

  publicInstance(instance, leaseId = '') {
    return { instanceId: instance.instanceId, componentId: instance.descriptor.componentId, pageId: instance.page.id, pageTitle: instance.page.title, surface: instance.context.surface, ...(leaseId ? { leaseId } : {}) };
  }

  publicContext(instance) {
    const { workspacePath: _privateWorkspacePath, eventSender: _privateEventSender, emitComponentEvent: _privateEmit, ...publicContext } = instance.context;
    const applicationSettings = instance.context.surface === 'application.settings';
    const permissions = applicationSettings
      ? (instance.descriptor.service?.permissions || []).filter(permission => ['component.settings', 'component.lifecycle.read', 'component.lifecycle.manage', 'dialogs'].includes(permission))
      : instance.descriptor.service?.permissions || [];
    return {
      ...publicContext,
      hostApiVersion: instance.descriptor.hostApiVersion,
      permissions,
      events: applicationSettings ? [] : instance.descriptor.service?.events || [],
      themeContractVersion: 1,
      resolvedTheme: this.resolvedTheme,
    };
  }

  setResolvedTheme(value) {
    const resolvedTheme = normalizeResolvedTheme(value);
    if (this.resolvedTheme === resolvedTheme) return false;
    this.resolvedTheme = resolvedTheme;
    for (const instance of this.instances.values()) if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send('component-sdk:theme-changed', { contractVersion: 1, resolvedTheme });
    return true;
  }

  activate(instanceId) {
    const found = !instanceId || [...this.instances.values()].some(instance => instance.instanceId === instanceId);
    if (!found) return false;
    this.activeInstanceId = instanceId;
    for (const instance of this.instances.values()) {
      const active = instance.instanceId === instanceId;
      if (instance.logicalActive !== active) {
        instance.logicalActive = active;
        if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send(active ? 'component-sdk:activate' : 'component-sdk:deactivate');
      }
      this.applyVisibility(instance);
    }
    return Boolean(instanceId);
  }

  applyVisibility(instance) {
    instance.view.setVisible(instance.logicalActive && !this.hostSurfaceState.suspended);
  }

  setHostSurfaceSuspended(update) {
    const rendererToken = String(update?.rendererToken || '');
    const revision = Number(update?.revision);
    if (!rendererToken || rendererToken.length > 200 || !Number.isSafeInteger(revision) || revision < 0 || typeof update?.suspended !== 'boolean') throw new Error('Invalid host surface state');
    if (rendererToken === this.hostSurfaceState.rendererToken && revision <= this.hostSurfaceState.revision) return false;
    const rendererReloaded = Boolean(this.hostSurfaceState.rendererToken && rendererToken !== this.hostSurfaceState.rendererToken);
    this.hostSurfaceState = { rendererToken, revision, suspended: update.suspended };
    if (rendererReloaded) this.activeInstanceId = '';
    for (const instance of this.instances.values()) {
      if (rendererReloaded && instance.logicalActive) {
        instance.logicalActive = false;
        if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send('component-sdk:deactivate');
      }
      this.applyVisibility(instance);
    }
    return true;
  }

  setBounds(instanceId, bounds) {
    if (!validBounds(bounds)) throw new Error('Invalid component page bounds');
    const instance = [...this.instances.values()].find(item => item.instanceId === instanceId);
    if (!instance) return false;
    instance.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    return true;
  }

  close(instanceId) {
    const instance = this.instancesById.get(instanceId);
    if (!instance) return false;
    if (this.instances.get(instance.key) === instance) this.instances.delete(instance.key);
    if (this.instancesById.get(instanceId) === instance) this.instancesById.delete(instanceId);
    if (this.activeInstanceId === instanceId) this.activeInstanceId = '';
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

  closeComponent(componentId) {
    const normalizedId = String(componentId || '');
    const ids = [...this.instances.values()]
      .filter(instance => instance.descriptor.componentId === normalizedId)
      .map(instance => instance.instanceId);
    ids.forEach(id => this.close(id));
    return ids.length;
  }

  destroy() { [...this.instances.values()].forEach(instance => this.close(instance.instanceId)); }
}

module.exports = { ComponentViewManager, componentPageKey, componentSettingsPageKey, normalizeOpenScope, normalizeResolvedTheme, selectComponentPreload, validBounds };
