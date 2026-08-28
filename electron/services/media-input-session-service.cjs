const SESSION = /^[a-zA-Z0-9_-]{8,96}$/;
const createMediaInputSessionService = ({ mediaService }) => {
  const sessions = new Map();
  const prepare = async ({ filePath, backendId, sessionId }) => {
    if (!SESSION.test(String(sessionId || '')) || !String(backendId || '') || sessions.has(sessionId)) throw new Error('媒体输入会话绑定无效');
    const authorizedPath = await mediaService.authorizeInput(filePath);
    const grant = { sessionId, backendId: String(backendId), processId: 0, authorizedPath, openedAt: Date.now() };
    sessions.set(sessionId, grant);
    return grant;
  };
  const bindProcess = ({ sessionId, backendId, processId }) => {
    const grant = sessions.get(String(sessionId || ''));
    if (!grant || grant.backendId !== String(backendId || '') || grant.processId || !Number.isSafeInteger(Number(processId)) || Number(processId) <= 0) throw new Error('媒体输入会话进程绑定无效');
    grant.processId = Number(processId); return Object.freeze({ ...grant });
  };
  const resolve = ({ sessionId, backendId, processId }) => {
    const grant = sessions.get(String(sessionId || ''));
    if (!grant || grant.backendId !== String(backendId || '') || grant.processId !== Number(processId)) throw new Error('媒体输入授权不存在或不属于当前后端进程');
    return grant.authorizedPath;
  };
  const revoke = sessionId => sessions.delete(String(sessionId || ''));
  const revokeProcess = processId => { let count = 0; for (const [id, grant] of sessions) if (grant.processId === Number(processId)) { sessions.delete(id); count += 1; } return count; };
  return { prepare, bindProcess, resolve, revoke, revokeProcess, sessions };
};
module.exports = { createMediaInputSessionService };
