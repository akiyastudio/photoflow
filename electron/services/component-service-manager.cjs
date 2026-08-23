const readline = require('readline');
const path = require('path');

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 4 * 60 * 60 * 1000;

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
  projectId: context.projectId,
  projectName: context.projectName,
  projectStatus: context.projectStatus,
});

const prepareReady = session => {
  session.readySettled = false;
  session.ready = new Promise((resolve, reject) => {
    session.readyResolve = value => { session.readySettled = true; resolve(value); };
    session.readyReject = error => { session.readySettled = true; reject(error); };
  });
};

class ComponentServiceManager {
  constructor({ registry, processSupervisor, capabilityBroker, executablePath = process.execPath, writeLog = () => undefined }) {
    this.registry = registry;
    this.processSupervisor = processSupervisor;
    this.capabilityBroker = capabilityBroker;
    this.executablePath = executablePath;
    this.writeLog = writeLog;
    this.sessions = new Map();
    this.nextRequestId = 1;
  }

  supports(componentId, method) {
    return Boolean(this.registry.resolve(componentId)?.service?.rpcMethods.includes(String(method || '')));
  }

  async invoke(componentId, method, payload, boundContext) {
    const descriptor = this.registry.resolve(componentId);
    if (!descriptor?.service?.rpcMethods.includes(String(method || ''))) throw new Error(`Unknown component service RPC method: ${method}`);
    const session = await this.ensureSession(descriptor);
    await session.ready;
    const id = String(this.nextRequestId++);
    const message = { type: 'request', id, method, payload: cloneRequestPayload(payload), context: publicContext(boundContext) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`Component service request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      session.pending.set(id, { resolve, reject, timer, context: boundContext });
      try { this.writeFrame(session, message); }
      catch (error) { clearTimeout(timer); session.pending.delete(id); reject(error); }
    });
  }

  async ensureSession(descriptor) {
    const existing = this.sessions.get(descriptor.componentId);
    if (existing && existing.version === descriptor.componentVersion && !existing.managed.released) return existing;
    if (existing) await existing.managed.stop('component-version-changed');
    const service = descriptor.service;
    const nodeRuntime = service.runtime === 'node';
    const command = nodeRuntime ? this.executablePath : service.entry;
    const args = nodeRuntime ? [service.entry] : [];
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
      id: `component-service:${descriptor.componentId}`,
      kind: 'component-service', command, args, options,
      health: { startupTimeoutMs: 15000 },
      restart: { enabled: true, maxRestarts: 2, windowMs: 60000, backoffMs: [100, 500] },
      onSpawn: (child, managed) => this.attach(session, child, managed),
    });
    session.managed.on('restart-exhausted', () => {
      if (!session.readySettled) session.readyReject(new Error('Component service restart limit reached'));
    });
    this.sessions.set(descriptor.componentId, session);
    return session;
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
      const error = new Error('Component service exited before completing requests');
      for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
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
      if (frame.ok === false) pending.reject(new Error(String(frame.error || 'Component service request failed')));
      else pending.resolve(frame.result);
      return;
    }
    if (frame?.type === 'capability') {
      const parent = session.pending.get(String(frame.parentId || ''));
      if (!parent) { this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: false, error: 'Unknown parent request' }); return; }
      try {
        const result = await this.capabilityBroker.invoke(session.descriptor, frame.method, frame.payload, parent.context);
        this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: true, result });
      } catch (error) {
        this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: false, error: error.message || String(error) });
      }
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
    const session = this.sessions.get(String(componentId || ''));
    if (!session) return false;
    this.sessions.delete(String(componentId));
    await session.managed.stop(reason);
    return true;
  }

  async destroy() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(session => session.managed.stop('component-service-manager-destroy')));
  }
}

module.exports = { ComponentServiceManager, MAX_LINE_BYTES, REQUEST_TIMEOUT_MS, cloneRequestPayload, prepareReady, publicContext, serviceEnvironment };
