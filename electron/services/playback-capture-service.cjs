const createPlaybackCaptureService = ({ crypto, fs, path, authorizeProjectMedia, clock = Date.now, ttlMs = 10_000 }) => {
  const stages = new Map();
  const ownerMatches = (stage, owner) => stage.sessionId === String(owner.sessionId) && stage.componentId === String(owner.componentId) && stage.processId === Number(owner.processId);
  const completePng = async filePath => {
    const handle = await fs.promises.open(filePath, 'r').catch(() => null); if (!handle) return false;
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size < 20 || stat.size > 100 * 1024 * 1024) return false; const head = Buffer.alloc(8), tail = Buffer.alloc(12); await handle.read(head, 0, 8, 0); await handle.read(tail, 0, 12, stat.size - 12); return head.toString('hex') === '89504e470d0a1a0a' && tail.readUInt32BE(0) === 0 && tail.subarray(4, 8).toString('ascii') === 'IEND'; } finally { await handle.close(); }
  };
  const create = async ({ sessionId, componentId, processId, sourcePath }) => {
    const source = path.resolve(await authorizeProjectMedia(sourcePath)); const parsed = path.parse(source); const id = crypto.randomUUID();
    const stagePath = path.join(parsed.dir, `.${parsed.name}.${id}.photoflow-capture-stage.png`);
    const stage = { id, sessionId: String(sessionId), componentId: String(componentId), processId: Number(processId), stagePath, source, expiresAt: clock() + ttlMs, phase: 'created' }; stages.set(id, stage);
    return Object.freeze({ stageId: id, expiresAt: stage.expiresAt });
  };
  const resolve = (stageId, owner) => { const stage = stages.get(String(stageId)); if (!stage || stage.expiresAt <= clock() || stage.phase !== 'created') throw new Error('capture stage expired or revoked'); if (!ownerMatches(stage, owner)) throw new Error('capture stage owner mismatch'); return Object.freeze({ stageId: stage.id, stagePath: stage.stagePath, expiresAt: stage.expiresAt }); };
  const validate = async (stageId, owner) => { const stage = stages.get(String(stageId)); if (!stage || !ownerMatches(stage, owner)) throw new Error('capture stage owner mismatch'); return completePng(stage.stagePath); };
  const commit = async (stageId, owner, { deadlineAt = clock(), probeMs = 40 } = {}) => {
    const stage = stages.get(String(stageId)); if (!stage || stage.phase !== 'created' || !ownerMatches(stage, owner)) throw new Error('capture stage expired, committed, or owner mismatch');
    while (clock() <= Math.min(stage.expiresAt, deadlineAt)) { if (await completePng(stage.stagePath)) break; await new Promise(resolveDelay => setTimeout(resolveDelay, probeMs)); }
    if (!await completePng(stage.stagePath)) throw new Error('保存当前视频帧超时：capture stage is not a complete PNG');
    stage.phase = 'committing'; const parsed = path.parse(stage.source); const now = new Date(clock()); const pad = (n, l = 2) => String(n).padStart(l, '0'); const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(),3)}`;
    const finalPath = path.join(parsed.dir, `${parsed.name}_截图_${stamp}_${stage.id.slice(0,8)}.png`); await fs.promises.rename(stage.stagePath, finalPath); stage.phase = 'committed'; stages.delete(stage.id); return Object.freeze({ path: finalPath });
  };
  const abort = async stageId => { const stage = stages.get(String(stageId)); if (!stage || stage.phase === 'committing') return false; stages.delete(stage.id); await fs.promises.unlink(stage.stagePath).catch(() => undefined); return true; };
  const abortWhere = predicate => Promise.all([...stages.values()].filter(predicate).map(stage => abort(stage.id)));
  return { create, resolve, validate, commit, abort, abortSession: id => abortWhere(stage => stage.sessionId === String(id)), abortProcess: id => abortWhere(stage => stage.processId === Number(id)), abortComponent: id => abortWhere(stage => stage.componentId === String(id)), get size() { return stages.size; } };
};
module.exports = { createPlaybackCaptureService };
