const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const safeError = error => error?.message || String(error || 'unknown error');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class WindowsComponentJobControl {
  constructor({ child, pipeName, launchConfig, timeoutMs = 10000 }) {
    this.child = child;
    this.pipeName = pipeName;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = '';
    this.waiters = new Set();
    this.emptyConfirmed = false;
    this.failure = null;
    this.launchConfig = launchConfig;
    this.terminalVerdict = new Promise(resolve => { this.resolveTerminalVerdict = resolve; });
    this.ready = this.connect();
    child.once('exit', code => { this.hostExitCode = code; });
  }

  async connect() {
    const deadline = Date.now() + this.timeoutMs;
    const connectPipe = async suffix => {
      let connected;
      while (!connected && Date.now() < deadline && this.child.exitCode == null && this.child.signalCode == null) {
        try { connected = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(`\\\\.\\pipe\\${this.pipeName}-${suffix}`);
          const onError = error => { candidate.destroy(); reject(error); };
          candidate.once('error', onError);
          candidate.once('connect', () => { candidate.removeListener('error', onError); resolve(candidate); });
        });
        } catch (error) {
          if (this.child.exitCode != null || this.child.signalCode != null) throw Object.assign(new Error(`Windows Job host failed before control became ready: ${safeError(error)}`), { code: 'PROCESS_JOB_HOST_FAILED' });
          await delay(20);
        }
      }
      if (!connected) throw Object.assign(new Error('Timed out connecting to Windows Job host'), { code: 'PROCESS_JOB_CONTROL_TIMEOUT' });
      return connected;
    };
    let socket; let eventSocket;
    try {
      socket = await connectPipe('in'); eventSocket = await connectPipe('out'); this.socket = socket; this.eventSocket = eventSocket;
      eventSocket.setEncoding('utf8'); eventSocket.on('data', chunk => this.onData(chunk));
      socket.on('error', error => this.fail(error));
      eventSocket.on('error', error => { this.fail(error); this.socket?.destroy(); });
      eventSocket.on('end', () => this.finishEventStream());
      eventSocket.on('close', () => this.finishEventStream());
      const payload = Buffer.from(JSON.stringify(this.launchConfig), 'utf8');
      if (payload.length <= 0 || payload.length > 1024 * 1024) throw Object.assign(new Error('Windows Job launch configuration exceeds the safe bound'), { code: 'PROCESS_JOB_CONFIG_TOO_LARGE' });
      const header = Buffer.allocUnsafe(4); header.writeInt32LE(payload.length); socket.write(Buffer.concat([header, payload]));
      await this.waitFor(event => event.event === 'ready', Math.max(1, deadline - Date.now())); return this;
    } catch (error) { socket?.destroy(); eventSocket?.destroy(); this.fail(error); try { this.child.kill(); } catch { /* pipe EOF is the primary fail-closed path */ } throw error; }
  }

  onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > 65536) { const error=Object.assign(new Error('Windows Job control message exceeds the safe bound'),{code:'PROCESS_JOB_PROTOCOL_INVALID'});this.socket?.destroy();this.eventSocket?.destroy();this.fail(error);return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch { this.fail(new Error('Windows Job host sent invalid control data')); continue; }
      if (!['ready','status','terminated','empty','error'].includes(event?.event)) { const error=Object.assign(new Error('Windows Job host sent an unknown control event'),{code:'PROCESS_JOB_PROTOCOL_INVALID'});this.socket?.destroy();this.fail(error);continue; }
      if (event.event === 'error') { const error=Object.assign(new Error(`Windows Job host failed (${event.message||event.code||'unknown'})`),{code:'PROCESS_JOB_HOST_FAILED',nativeCode:event.code});if(event.treeConfirmed===true&&event.active===0){this.emptyConfirmed=true;this.failure=error;this.rejectAll(error);this.resolveVerdict(true);}else this.fail(error);this.socket?.destroy();continue; }
      if (event.event === 'ready') {
        if (!Number.isSafeInteger(event.targetPid) || event.targetPid <= 0 || !Number.isSafeInteger(event.active) || event.active < 1) { const error=Object.assign(new Error('Windows Job host sent an invalid ready event'),{code:'PROCESS_JOB_PROTOCOL_INVALID'});this.socket?.destroy();this.fail(error);continue; }
        this.targetPid = event.targetPid; this.child.__photoFlowTargetPid = event.targetPid;
      }
      if ((event.event === 'empty' || event.event === 'terminated') && event.active === 0 && event.confirmed !== false) { this.emptyConfirmed = true; this.resolveVerdict(true); }
      for (const waiter of [...this.waiters]) if (waiter.predicate(event)) { this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event); }
    }
  }

  resolveVerdict(confirmed) { if (this.terminalVerdictSettled) return; this.terminalVerdictSettled=true; this.resolveTerminalVerdict({ confirmed, error: this.failure || null }); }
  finishEventStream() { if (this.eventStreamDrained) return; this.eventStreamDrained=true; if (!this.emptyConfirmed) { this.fail(Object.assign(new Error(`Windows Job event stream ended without tree-zero evidence (hostExit=${this.hostExitCode ?? this.child.exitCode})`),{code:'PROCESS_TREE_TERMINATION_UNCONFIRMED'})); this.socket?.destroy(); } else this.resolveVerdict(true); }
  fail(error) { if (this.failure) return; this.failure = error; this.rejectAll(error); this.resolveVerdict(false); }
  rejectAll(error) { for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); } this.waiters.clear(); }
  waitFor(predicate, timeoutMs) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(Object.assign(new Error('Windows Job control response timed out'), { code: 'PROCESS_JOB_CONTROL_TIMEOUT' })); }, Math.max(1, timeoutMs));
      waiter.timer.unref?.(); this.waiters.add(waiter);
    });
  }
  async terminate(deadlineAt) {
    await this.ready;
    if (this.emptyConfirmed) return { confirmed: true, active: 0 };
    const response = this.waitFor(event => event.event === 'terminated' || event.event === 'empty' || event.event === 'error', Math.max(1, deadlineAt - Date.now()));
    const remaining=Math.max(1,deadlineAt-Date.now());
    await new Promise((resolve,reject)=>this.socket.write(`terminate ${remaining}\n`,error=>error?reject(error):resolve()));
    const event = await response;
    if (event.event === 'error' || event.active !== 0 || event.event === 'terminated' && event.confirmed !== true) throw Object.assign(new Error('Windows Job host could not confirm process-tree termination'), { code: 'PROCESS_TREE_TERMINATION_FAILED' });
    this.emptyConfirmed = true;
    return { confirmed: true, active: 0 };
  }
  async status(timeoutMs = 2000) { await this.ready; const response=this.waitFor(event=>event.event==='status',timeoutMs);this.socket.write('status\n');return response; }
}

const resolveDefaultJobHost = () => path.resolve(__dirname, '..', 'bin', 'component-job-host.exe');
const wrapComponentJobSpecification = (specification, { jobHostPath = resolveDefaultJobHost() } = {}) => {
  if (process.platform !== 'win32' || specification?.windowsJob !== true || !specification?.owner?.componentId) return specification;
  const resolvedHost = path.resolve(jobHostPath);
  const hostStat = fs.lstatSync(resolvedHost, { throwIfNoEntry: false });
  if (!hostStat?.isFile() || hostStat.isSymbolicLink()) throw Object.assign(new Error(`Windows component Job host is unavailable or unsafe: ${resolvedHost}`), { code: 'PROCESS_JOB_HOST_MISSING' });
  const expectedHash = fs.readFileSync(`${resolvedHost}.sha256`, 'utf8').trim().toLowerCase();
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(resolvedHost)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== actualHash) throw Object.assign(new Error('Windows component Job host integrity verification failed'), { code: 'PROCESS_JOB_HOST_INTEGRITY' });
  const pipeName = `photoflow-component-job-${process.pid}-${crypto.randomUUID()}`;
  const targetOptions = specification.options || {};
  const wrapped = {
    ...specification,
    command: resolvedHost,
    args: ['--pipe', pipeName, '--parent', String(process.pid)],
    options: { ...targetOptions },
  };
  const originalOnSpawn = specification.onSpawn;
  wrapped.onSpawn = (child, managed) => {
    child.__photoFlowJobControl = new WindowsComponentJobControl({ child, pipeName, launchConfig: {
      command: specification.command,
      args: specification.args || [],
      cwd: targetOptions.cwd || process.cwd(),
      env: targetOptions.env || process.env,
    } });
    void child.__photoFlowJobControl.ready.catch(() => undefined);
    originalOnSpawn?.(child, managed);
  };
  return wrapped;
};

module.exports = { WindowsComponentJobControl, resolveDefaultJobHost, wrapComponentJobSpecification };
