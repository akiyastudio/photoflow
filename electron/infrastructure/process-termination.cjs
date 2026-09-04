const { execFile } = require('child_process');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
const childHasExited = child => !child || child.exitCode != null || child.signalCode != null;
const waitForChildExit = (child, deadlineAt = Infinity) => {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer = null;
    const finish = () => {
      child.removeListener?.('exit', finish);
      child.removeListener?.('close', finish);
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', finish);
    child.once('close', finish);
    // The process may exit between the initial probe and listener attachment.
    if (childHasExited(child)) return finish();
    if (Number.isFinite(deadlineAt)) timer = setTimeout(() => {
      child.removeListener?.('exit', finish);
      child.removeListener?.('close', finish);
      resolve(childHasExited(child));
    }, Math.max(0, deadlineAt - Date.now()));
  });
};

const terminateWindowsProcessTree = (pid, deadlineAt, execFileImpl = execFile) => new Promise((resolve, reject) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return reject(Object.assign(new Error('Invalid child PID for process-tree termination'), { code: 'PROCESS_TERMINATION_INVALID_PID' }));
  const timeout = Math.max(1, Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : 2000);
  execFileImpl('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout }, error => error ? reject(error) : resolve());
});

const terminateAndWait = async (child, deadlineAt, { rollbackSettleMs = 25, platform = process.platform, execFileImpl = execFile } = {}) => {
  if (!child) return { exited: true, forced: false };
  if (platform === 'test' && child.killed) return { exited: true, forced: true };
  const terminationDeadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + 2000;
  if (platform === 'win32' && child.__photoFlowJobManaged) {
    if (!child.__photoFlowTreeExitConfirmed) await child.terminateJob(terminationDeadline);
    if (!child.__photoFlowTreeExitConfirmed) {
      child.__photoFlowTreeTerminationUnconfirmed = true;
      const error = new Error('Windows Job termination was not confirmed by ActiveProcesses=0');
      error.code = 'PROCESS_TREE_TERMINATION_UNCONFIRMED'; error.pid = child.pid || null;
      throw error;
    }
    if (rollbackSettleMs > 0) await delay(rollbackSettleMs);
    return { exited: true, forced: true, activeProcessCount: 0 };
  }
  if (platform === 'win32' && child.__photoFlowTreeTerminationUnconfirmed && childHasExited(child)) {
    const error = new Error('组件服务父进程已退出，但无法确认其 Windows 子进程树已终止');
    error.code = 'PROCESS_TREE_TERMINATION_UNCONFIRMED'; error.pid = child.pid || null;
    throw error;
  }
  try { child.stdin?.end?.(); } catch { /* stdin may already be closed */ }
  try { child.stdin?.destroy?.(); } catch { /* best effort */ }
  let forced = false;
  let treeTerminationError = null;
  if (!childHasExited(child) && platform === 'win32') {
    forced = true;
    try { await terminateWindowsProcessTree(child.pid, terminationDeadline, execFileImpl); child.__photoFlowTreeTerminationUnconfirmed = false; }
    catch (error) { child.__photoFlowTreeTerminationUnconfirmed = true; treeTerminationError = error; }
  } else if (!childHasExited(child)) {
    try { child.kill(); } catch { /* exit may already be in flight */ }
  }
  if (treeTerminationError) {
    const error = new Error('Windows 组件服务进程树终止失败');
    error.code = 'PROCESS_TREE_TERMINATION_FAILED'; error.pid = child.pid || null; error.cause = treeTerminationError;
    throw error;
  }
  let exited = childHasExited(child);
  if (!exited) exited = await waitForChildExit(child, platform === 'win32' ? terminationDeadline : Date.now() + Math.min(500, Math.floor(Math.max(0, terminationDeadline - Date.now()) / 2)));
  if (!exited && platform !== 'win32') {
    forced = true;
    let forcedByChild = false;
    try { forcedByChild = child.kill('SIGKILL') !== false; } catch { /* fall through to PID kill */ }
    if (!forcedByChild && child.pid) try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exiting */ }
    exited = await waitForChildExit(child, terminationDeadline);
  }
  if (!exited) {
    const error = new Error('无法确认子进程已退出，数据库可能仍被占用');
    error.code = 'PROCESS_TERMINATION_FAILED';
    error.pid = child.pid || null;
    if (treeTerminationError) error.cause = treeTerminationError;
    throw error;
  }
  if (rollbackSettleMs > 0) await delay(rollbackSettleMs);
  return { exited: true, forced };
};

const stopProcessAndWait = (child, timeoutMs = 2000, options = {}) => terminateAndWait(child, Date.now() + Math.max(0, timeoutMs), options);

module.exports = { stopProcessAndWait, terminateAndWait, terminateWindowsProcessTree };
