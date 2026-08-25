const readline = require('readline');
const path = require('path');
const { LEGACY_COALESCED_READ_METHODS, LEGACY_LONG_RUNNING_METHODS } = require('../compatibility/component-v1-metadata.cjs');

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const LONG_RUNNING_METHODS = new Set(LEGACY_LONG_RUNNING_METHODS);
const LONG_REQUEST_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const COALESCED_READ_METHODS = new Set(LEGACY_COALESCED_READ_METHODS);

const cloneRequestPayload = payload => {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Component service payload must be an object');
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_LINE_BYTES) throw new RangeError('Component service payload is too large');
  return JSON.parse(serialized);
};

const serviceEnvironment = (source = process.env) => Object.fromEntries([
  'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
].filter(key => typeof source[key] === 'string' && source[key]).map(key => [key, source[key]]));

const publicContext = context => Object.freeze({
  componentId: context.componentId,
  componentVersion: context.componentVersion,
  surface: context.surface || 'project',
  projectId: context.projectId,
  projectName: context.projectName,
  projectStatus: context.projectStatus,
});

const algorithmRuntimeArgs = descriptor => descriptor.algorithmRuntime ? [
  '--photoflow-algorithm-command', descriptor.algorithmRuntime.command,
  ...descriptor.algorithmRuntime.argsPrefix.flatMap(value => ['--photoflow-algorithm-arg-prefix', value]),
] : [];

const prepareReady = session => {
  session.readySettled = false;
  session.ready = new Promise((resolve, reject) => {
    session.readyResolve = value => { session.readySettled = true; resolve(value); };
    session.readyReject = error => { session.readySettled = true; reject(error); };
  });
};

class ComponentServiceManager {
  constructor({ registry, processSupervisor, capabilityBroker, executablePath = process.execPath, writeLog = () => undefined, requestTimeoutMs = REQUEST_TIMEOUT_MS, longRequestTimeoutMs = LONG_REQUEST_TIMEOUT_MS }) {
    this.registry = registry;
    this.processSupervisor = processSupervisor;
    this.capabilityBroker = capabilityBroker;
    this.executablePath = executablePath;
    this.writeLog = writeLog;
    this.requestTimeoutMs = requestTimeoutMs;
    this.longRequestTimeoutMs = longRequestTimeoutMs;
    this.sessions = new Map();
    this.sessionTransitions = new Map();
    this.inflightReads = new Map();
    this.nextRequestId = 1;
    this.storageSnapshotBarrier = null;
    this.activeInvocations = 0;
    this.activityWaiters = new Set();
  }

  supports(componentId, method) {
    return Boolean(this.registry.resolve(componentId)?.service?.rpcMethods.includes(String(method || '')));
  }

  async invoke(componentId, method, payload, boundContext) {
    if (this.storageSnapshotBarrier) {
      await this.storageSnapshotBarrier.released;
      return this.invoke(componentId, method, payload, boundContext);
    }
    this.activeInvocations += 1;
    try {
    const descriptor = this.registry.resolve(componentId);
    if (!descriptor?.service?.rpcMethods.includes(String(method || ''))) throw new Error(`Unknown component service RPC method: ${method}`);
    this.capabilityBroker.assertCapabilities(descriptor);
    const normalizedMethod = String(method || '');
    const normalizedPayload = cloneRequestPayload(payload);
    if (COALESCED_READ_METHODS.has(normalizedMethod)) {
      const key = JSON.stringify([descriptor.componentId, descriptor.componentVersion, normalizedMethod, path.resolve(String(boundContext.workspacePath || '.')).toLocaleLowerCase(), boundContext.projectId, boundContext.projectName, boundContext.projectStatus, normalizedPayload]);
      const existing = this.inflightReads.get(key);
      if (existing) return existing;
      const operation = this.invokeOnce(descriptor, normalizedMethod, normalizedPayload, boundContext).finally(() => {
        if (this.inflightReads.get(key) === operation) this.inflightReads.delete(key);
      });
      this.inflightReads.set(key, operation);
      return await operation;
    }
    return await this.invokeOnce(descriptor, normalizedMethod, normalizedPayload, boundContext);
    } finally {
      this.activeInvocations -= 1;
      if (this.activeInvocations === 0) {
        for (const notify of this.activityWaiters) notify();
        this.activityWaiters.clear();
      }
    }
  }

  async invokeOnce(descriptor, method, payload, boundContext) {
    const session = await this.ensureSession(descriptor);
    await session.ready;
    const id = String(this.nextRequestId++);
    const message = { type: 'request', id, method, payload, context: {
      ...publicContext(boundContext),
      hostApiVersion: descriptor.hostApiVersion,
      permissions: boundContext.surface === 'application.settings'
        ? (descriptor.service.permissions || []).filter(permission => ['component.settings', 'component.lifecycle.read', 'component.lifecycle.manage', 'dialogs', 'notifications'].includes(permission))
        : descriptor.service.permissions || [],
    } };
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const pending = { resolve, reject, timer: null, context: boundContext, method, startedAt, lastCapability: '', capabilityStartedAt: 0, longTimeoutArmed: LONG_RUNNING_METHODS.has(String(method || '')), onTimeout: null };
      pending.onTimeout = () => {
        if (session.pending.get(id) !== pending) return;
        session.pending.delete(id);
        let cancelError = null;
        try { this.writeFrame(session, { type: 'cancel', id, reason: 'deadline-exceeded' }); }
        catch (error) { cancelError = error; }
        const elapsedMs = Date.now() - startedAt;
        const capability = pending.lastCapability
          ? `; last capability ${pending.lastCapability} for ${Math.max(0, Date.now() - pending.capabilityStartedAt)}ms`
          : '; no capability response was pending';
        const error = new Error(`Component service request timed out after ${elapsedMs}ms: ${descriptor.componentId}.${method}${capability}`);
        error.code = 'COMPONENT_HOST_TIMEOUT';
        reject(error);
        try { this.writeLog('warn', 'Component service request timed out', { componentId: descriptor.componentId, method, elapsedMs, lastCapability: pending.lastCapability || '', pendingCount: session.pending.size }); } catch { /* Timeout rejection must not depend on logging. */ }
        if (cancelError) try { this.writeLog('warn', 'Component service timeout cancellation could not be delivered', { componentId: descriptor.componentId, method, error: cancelError.message || String(cancelError) }); } catch { /* Best effort only. */ }
      };
      pending.timer = setTimeout(pending.onTimeout, pending.longTimeoutArmed ? this.longRequestTimeoutMs : this.requestTimeoutMs);
      pending.timer.unref?.();
      session.pending.set(id, pending);
      try { this.writeFrame(session, message); }
      catch (error) { clearTimeout(pending.timer); session.pending.delete(id); reject(error); }
    });
  }

  async ensureSession(descriptor) {
    if (this.storageSnapshotBarrier) {
      await this.storageSnapshotBarrier.released;
      return this.ensureSession(descriptor);
    }
    const componentId = descriptor.componentId;
    const existing = this.sessions.get(componentId);
    if (existing && existing.version === descriptor.componentVersion && !existing.managed.released) return existing;
    const activeTransition = this.sessionTransitions.get(componentId);
    if (activeTransition) { await activeTransition; return this.ensureSession(descriptor); }
    const transition = (async () => {
      const current = this.sessions.get(componentId);
      if (current && current.version === descriptor.componentVersion && !current.managed.released) return current;
      if (current) await current.managed.stop('component-version-changed');
      const service = descriptor.service;
      const nodeRuntime = service.runtime === 'node';
      const command = nodeRuntime ? this.executablePath : service.entry;
      const args = nodeRuntime ? [service.entry, ...algorithmRuntimeArgs(descriptor)] : [];
      const options = {
        cwd: path.dirname(service.entry),
        env: { ...serviceEnvironment(), ...(nodeRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      const session = {
        descriptor, version: descriptor.componentVersion, pending: new Map(), bufferBytes: 0,
        ready: null, readyResolve: null, readyReject: null, readySettled: false, managed: null,
      };
      prepareReady(session);
      session.managed = this.processSupervisor.launch({
        id: `component-service:${componentId}`,
        kind: 'component-service', command, args, options,
        health: { startupTimeoutMs: 15000 },
        restart: { enabled: true, maxRestarts: 2, windowMs: 60000, backoffMs: [100, 500] },
        onSpawn: (child, managed) => this.attach(session, child, managed),
      });
      session.managed.on('restart-exhausted', () => {
        if (!session.readySettled) session.readyReject(new Error('Component service restart limit reached'));
      });
      this.sessions.set(componentId, session);
      return session;
    })();
    this.sessionTransitions.set(componentId, transition);
    try { return await transition; }
    finally { if (this.sessionTransitions.get(componentId) === transition) this.sessionTransitions.delete(componentId); }
  }

  attach(session, child, managed) {
    if (session.readySettled) prepareReady(session);
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { managed.recycle('oversized-protocol-frame'); return; }
      let frame;
      try { frame = JSON.parse(line); } catch { managed.recycle('invalid-protocol-frame'); return; }
      void this.handleFrame(session, frame, managed).catch(error => {
        this.writeLog('warn', 'Component service protocol handling failed', { componentId: session.descriptor.componentId, error: error.message || String(error) });
        managed.recycle('protocol-handler-failed');
      });
    });
    child.once('exit', () => {
      lines.close();
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        const error = new Error(`Component service exited before completing ${session.descriptor.componentId}.${pending.method}`);
        error.code = 'COMPONENT_HOST_SERVICE_EXITED';
        pending.reject(error);
      }
      session.pending.clear();
      if (session.readySettled) prepareReady(session);
    });
  }

  async handleFrame(session, frame, managed) {
    if (frame?.type === 'ready' && Number(frame.protocolVersion) === session.descriptor.service.protocolVersion) {
      managed.markHealthy({ protocol: `component-service-v${frame.protocolVersion}` });
      session.readyResolve();
      return;
    }
    if (frame?.type === 'response') {
      const pending = session.pending.get(String(frame.id || ''));
      if (!pending) return;
      session.pending.delete(String(frame.id));
      clearTimeout(pending.timer);
      if (frame.ok === false) {
        const error = new Error(String(frame.error || 'Component service request failed'));
        error.code = String(frame.errorCode || 'COMPONENT_SERVICE_REQUEST_FAILED');
        error.retryable = frame.retryable === true;
        pending.reject(error);
      } else pending.resolve(frame.result);
      return;
    }
    if (frame?.type === 'capability') {
      const parent = session.pending.get(String(frame.parentId || ''));
      if (!parent) { this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: false, error: 'Unknown parent request' }); return; }
      parent.lastCapability = String(frame.method || '');
      const capabilityStartedAt = Date.now();
      parent.capabilityStartedAt = capabilityStartedAt;
      try {
        const invocation = this.capabilityBroker.invoke(session.descriptor, frame.method, frame.payload, parent.context);
        if (frame.method === 'component.lifecycle.v2' && ['preflight', 'install', 'repair', 'uninstall'].includes(String(frame.payload?.action || '')) && !parent.longTimeoutArmed) {
          clearTimeout(parent.timer);
          parent.longTimeoutArmed = true;
          parent.timer = setTimeout(parent.onTimeout, this.longRequestTimeoutMs);
          parent.timer.unref?.();
        }
        const result = await invocation;
        this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: true, result });
      } catch (error) {
        this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: false, error: error.message || String(error), errorCode: error.code || 'COMPONENT_HOST_INTERNAL', retryable: error.retryable === true });
      } finally {
        if (session.pending.get(String(frame.parentId || '')) === parent && parent.capabilityStartedAt === capabilityStartedAt) {
          parent.lastCapability = '';
          parent.capabilityStartedAt = 0;
        }
      }
      return;
    }
    if (frame?.type === 'metric') {
      this.writeLog('info', 'Component service migration phase', {
        componentId: session.descriptor.componentId,
        migration: String(frame.migration || ''), phase: String(frame.phase || ''),
        itemCount: Math.max(0, Number(frame.itemCount) || 0), byteCount: Math.max(0, Number(frame.byteCount) || 0),
        elapsedMs: Math.max(0, Number(frame.elapsedMs) || 0), state: String(frame.state || ''),
      });
      return;
    }
    managed.recycle('unexpected-protocol-frame');
  }

  writeFrame(session, value) {
    const child = session.managed.child;
    if (!child?.stdin?.writable) throw new Error('Component service is unavailable');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async stop(componentId, reason = 'component-service-stop') {
    const id = String(componentId || '');
    await this.sessionTransitions.get(id)?.catch(() => undefined);
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.managed.stop(reason);
    return true;
  }

  async quiesceForStorageSnapshot({ timeoutMs = 5000 } = {}) {
    if (this.storageSnapshotBarrier) {
      await this.storageSnapshotBarrier.released;
      return this.quiesceForStorageSnapshot();
    }
    let releaseBarrier;
    const barrier = { released: new Promise(resolve => { releaseBarrier = resolve; }), release: () => releaseBarrier() };
    this.storageSnapshotBarrier = barrier;
    if (this.activeInvocations > 0) {
      let timer;
      let activityNotify;
      try {
        await Promise.race([
          new Promise(resolve => { activityNotify = resolve; this.activityWaiters.add(resolve); }),
          new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('Component service is busy; storage snapshot was deferred'); error.code = 'COMPONENT_BUSY'; reject(error); }, timeoutMs); }),
        ]);
      } catch (error) {
        if (this.storageSnapshotBarrier === barrier) this.storageSnapshotBarrier = null;
        releaseBarrier();
        throw error;
      } finally { clearTimeout(timer); if (activityNotify) this.activityWaiters.delete(activityNotify); }
    }
    await Promise.allSettled([...this.sessionTransitions.values()]);
    const descriptors = [...this.sessions.values()].map(session => session.descriptor);
    const stopResults = await Promise.allSettled(descriptors.map(descriptor => this.stop(descriptor.componentId, 'component-storage-snapshot')));
    const stopErrors = stopResults.filter(result => result.status === 'rejected').map(result => result.reason);
    if (stopErrors.length) {
      if (this.storageSnapshotBarrier === barrier) this.storageSnapshotBarrier = null;
      releaseBarrier();
      const restoreResults = await Promise.allSettled(descriptors.map(descriptor => this.ensureSession(descriptor)));
      const restoreErrors = restoreResults.filter(result => result.status === 'rejected').map(result => result.reason);
      throw new AggregateError([...stopErrors, ...restoreErrors], 'Unable to quiesce every component service for storage snapshot');
    }
    let resumed = false;
    return async () => {
      if (resumed) return;
      resumed = true;
      if (this.storageSnapshotBarrier === barrier) this.storageSnapshotBarrier = null;
      releaseBarrier();
      const results = await Promise.allSettled(descriptors.map(descriptor => this.ensureSession(descriptor)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Unable to resume every component service after storage snapshot');
    };
  }

  async destroy() {
    const barrier = this.storageSnapshotBarrier;
    this.storageSnapshotBarrier = null;
    barrier?.release();
    await Promise.allSettled([...this.sessionTransitions.values()]);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(session => session.managed.stop('component-service-manager-destroy')));
  }
}

module.exports = { COALESCED_READ_METHODS, ComponentServiceManager, LONG_REQUEST_TIMEOUT_MS, MAX_LINE_BYTES, REQUEST_TIMEOUT_MS, cloneRequestPayload, prepareReady, publicContext, serviceEnvironment };
