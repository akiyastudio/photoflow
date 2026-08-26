const path = require('path');

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
const MIN_COMPONENT_SURFACE_HEIGHT = 120;
const componentViewBoundsWithHostOverlay = (bounds, reservedBottom) => {
  const maximumReservedBottom = bounds.y + Math.max(0, bounds.height - Math.min(bounds.height, MIN_COMPONENT_SURFACE_HEIGHT));
  const bottom = Math.max(bounds.y, Math.min(maximumReservedBottom, Number(reservedBottom) || 0));
  return { x: Math.round(bounds.x), y: Math.round(bottom), width: Math.round(bounds.width), height: Math.round(Math.max(0, bounds.y + bounds.height - bottom)) };
};
const selectComponentPreload = (descriptor, { core }) => {
  const contractVersion = Number(descriptor?.contractVersion);
  const hostApiVersion = Number(descriptor?.hostApiVersion);
  if (contractVersion === 2 && hostApiVersion >= 2) return core;
  throw new Error(`Unsupported component preload contract: contract=${contractVersion || 'unknown'} hostApi=${hostApiVersion || 'unknown'}`);
};
const diagnosticToken = value => {
  const token = String(value || '').trim();
  return /^[a-z0-9_.:-]{1,80}$/i.test(token) ? token : 'unknown';
};

class ComponentViewManager {
  constructor({ WebContentsView, mainWindow, registry, preloadPath, ipcMain, serviceManager = null, notificationService = null, writeLog = () => undefined }) {
    this.WebContentsView = WebContentsView;
    this.mainWindow = mainWindow;
    this.registry = registry;
    this.preloadPath = preloadPath;
    this.ipcMain = ipcMain;
    this.writeLog = writeLog;
    this.serviceManager = serviceManager;
    this.notificationService = notificationService;
    this.instances = new Map();
    this.instancesById = new Map();
    this.senderBindings = new Map();
    this.rpcMethods = new Map();
    this.resolvedTheme = 'light';
    this.activeInstanceId = '';
    this.hostSurfaceState = { rendererToken: '', revision: -1, suspended: false };
    this.hostToastReservation = { rendererToken: '', revision: -1, bottom: 0 };
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
    this.ipcMain.handle('component-sdk:notify', (event, payload) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) { const error = new Error('Unauthorized component sender'); error.code = 'NOTIFICATION_UNAUTHORIZED_SENDER'; throw error; }
      if (!this.notificationService) { const error = new Error('Component notification service is unavailable'); error.code = 'NOTIFICATION_HOST_UNAVAILABLE'; throw error; }
      return this.notificationService.publish(instance.descriptor, payload, instance.context);
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
      label: item.development ? `${item.toolbarAction.label}（开发）` : item.toolbarAction.label,
      pageId: item.fullPage.id,
      pageTitle: item.development ? `${item.fullPage.title}（开发组件）` : item.fullPage.title,
      development: item.development === true,
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
      label: item.development ? `${page.label}（开发）` : page.label,
      pageTitle: item.development ? `${page.title}（开发组件）` : page.title,
      development: item.development === true,
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
    const selectedPreloadPath = selectComponentPreload(descriptor, { core: this.preloadPath });
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
      requestedBounds: { x: 0, y: 0, width: 0, height: 0 },
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
      if (![...this.senderBindings.values()].some(bound => bound.context.componentId === descriptor.componentId)) this.notificationService?.clearComponent?.(descriptor.componentId);
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
      ? (instance.descriptor.service?.permissions || []).filter(permission => ['component.settings', 'component.lifecycle.read', 'component.lifecycle.manage', 'dialogs', 'notifications'].includes(permission))
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
      this.applyBounds(instance);
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
    if (rendererReloaded && this.hostToastReservation.rendererToken !== rendererToken) {
      this.hostToastReservation = { rendererToken, revision: -1, bottom: 0 };
      for (const instance of this.instances.values()) this.applyBounds(instance);
    }
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
    instance.requestedBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    this.applyBounds(instance);
    return true;
  }

  applyBounds(instance) {
    const reservedBottom = instance.logicalActive && instance.instanceId === this.activeInstanceId ? this.hostToastReservation.bottom : 0;
    instance.view.setBounds(componentViewBoundsWithHostOverlay(instance.requestedBounds, reservedBottom));
  }

  setHostToastReservation(update) {
    const rendererToken = String(update?.rendererToken || '');
    const revision = Number(update?.revision);
    const bottom = Number(update?.bottom);
    if (!rendererToken || rendererToken.length > 200 || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(bottom) || bottom < 0 || bottom > 20000) throw new Error('Invalid host toast reservation');
    if (rendererToken !== this.hostToastReservation.rendererToken) this.hostToastReservation = { rendererToken, revision: -1, bottom: 0 };
    if (revision <= this.hostToastReservation.revision) return false;
    const changed = bottom !== this.hostToastReservation.bottom;
    this.hostToastReservation = { rendererToken, revision, bottom };
    if (changed) for (const instance of this.instances.values()) this.applyBounds(instance);
    return changed;
  }

  setNotificationRendererReady(ready) { return this.notificationService?.setRendererReady?.(ready) || { ready: false, flushed: 0 }; }

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
    this.notificationService?.clearComponent?.(normalizedId);
    return ids.length;
  }

  destroy() { [...this.instances.values()].forEach(instance => this.close(instance.instanceId)); this.notificationService?.destroy?.(); }
}

module.exports = { MIN_COMPONENT_SURFACE_HEIGHT, ComponentViewManager, componentPageKey, componentSettingsPageKey, componentViewBoundsWithHostOverlay, normalizeOpenScope, normalizeResolvedTheme, selectComponentPreload, validBounds };
