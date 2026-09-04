const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identityFor = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameIdentity = (left, right) => left && right && Object.keys(left).every(key => left[key] === right[key]);

const acquireReleaseLock = repositoryRoot => {
  const lockPath = path.join(repositoryRoot, 'artifacts', 'release.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const record = { schemaVersion: 1, pid: process.pid, host: os.hostname(), attemptId: crypto.randomUUID(), startedAt: new Date().toISOString() };
  const attempt = () => { const fd = fs.openSync(lockPath, 'wx'); fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); return { fd, lockPath, record, identity: identityFor(fs.fstatSync(fd)) }; };
  try { return attempt(); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { throw new Error(`发布锁损坏；请人工核验：${lockPath}`); }
    if (previous.host !== os.hostname() || !Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error(`发布锁来源无法安全确认：${lockPath}`);
    try { process.kill(previous.pid, 0); throw new Error(`另一个发布 session 正在运行：PID ${previous.pid}`); }
    catch (probe) { if (!['ESRCH', 'EINVAL'].includes(probe?.code)) throw probe; }
    const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`;
    fs.renameSync(lockPath, stalePath);
    return attempt();
  }
};
const releaseLock = lock => {
  const pathStat = fs.statSync(lock.lockPath, { throwIfNoEntry: false });
  let current = null;
  try { current = pathStat?.isFile() ? JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) : null; } catch { /* handled below */ }
  const owned = pathStat && sameIdentity(lock.identity, identityFor(pathStat)) && current?.attemptId === lock.record.attemptId;
  fs.closeSync(lock.fd);
  if (!owned) throw new Error(`发布锁已被替换；拒绝删除非本 session 锁：${lock.lockPath}`);
  fs.rmSync(lock.lockPath);
};

module.exports = { acquireReleaseLock, releaseLock };
