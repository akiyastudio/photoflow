const delay = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
const childHasExited = child => !child || child.exitCode != null || child.signalCode != null;
const waitForChildExit = (child, deadlineAt = Infinity) => {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer = null;
    const finish = () => {
      child.removeListener?.('exit', finish);
      child.removeListener?.('close', finish);
      child.removeListener?.('error', finish);
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', finish);
    if (Number.isFinite(deadlineAt)) timer = setTimeout(() => {
      child.removeListener?.('exit', finish);
      child.removeListener?.('close', finish);
      child.removeListener?.('error', finish);
      resolve(childHasExited(child));
    }, Math.max(0, deadlineAt - Date.now()));
  });
};

const terminateAndWait = async (child, deadlineAt, { rollbackSettleMs = 25 } = {}) => {
  if (!child) return { exited: true, forced: false };
  const terminationDeadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + 2000;
  try { child.stdin?.end?.(); } catch { /* stdin may already be closed */ }
  try { child.stdin?.destroy?.(); } catch { /* best effort */ }
  if (!childHasExited(child)) try { child.kill(); } catch { /* exit may already be in flight */ }
  let exited = childHasExited(child);
  if (!exited) exited = await waitForChildExit(child, Date.now() + Math.min(500, Math.floor(Math.max(0, terminationDeadline - Date.now()) / 2)));
  let forced = false;
  if (!exited) {
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
    throw error;
  }
  if (rollbackSettleMs > 0) await delay(rollbackSettleMs);
  return { exited: true, forced };
};

const stopProcessAndWait = (child, timeoutMs = 2000, options = {}) => terminateAndWait(child, Date.now() + Math.max(0, timeoutMs), options);

module.exports = { stopProcessAndWait, terminateAndWait };
