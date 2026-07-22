const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const createMediaAccessService = ({ getWorkspaceRoots, getAdditionalRoots = () => [] }) => {
  const grants = new Map();
  const TOKEN_TTL_MS = 60 * 60 * 1000;

  const isInside = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  const realExistingPath = async value => fs.promises.realpath(path.resolve(String(value || '')));

  const authorizeInput = async value => {
    if (typeof value === 'string' && value.startsWith('media-token:')) {
      const token = value.slice('media-token:'.length);
      const grant = grants.get(token);
      if (!grant || grant.expiresAt < Date.now()) {
        grants.delete(token);
        throw new Error('媒体访问授权已失效');
      }
      return grant.path;
    }
    const candidate = await realExistingPath(value);
    const roots = [...getWorkspaceRoots(), ...getAdditionalRoots()].filter(Boolean);
    for (const rootValue of roots) {
      try {
        const root = await fs.promises.realpath(path.resolve(rootValue));
        if (isInside(root, candidate)) return candidate;
      } catch { /* unavailable roots do not grant access */ }
    }
    throw new Error('媒体文件不在已授权的工作区或缓存目录中');
  };

  const grantPath = value => {
    const candidate = path.resolve(String(value || ''));
    const token = crypto.randomBytes(24).toString('base64url');
    grants.set(token, { path: candidate, expiresAt: Date.now() + TOKEN_TTL_MS });
    if (grants.size > 5000) {
      const now = Date.now();
      for (const [key, grant] of grants) if (grant.expiresAt < now) grants.delete(key);
      while (grants.size > 5000) grants.delete(grants.keys().next().value);
    }
    return token;
  };

  const resolveToken = token => {
    const grant = grants.get(token);
    if (!grant || grant.expiresAt < Date.now()) {
      grants.delete(token);
      return null;
    }
    grant.expiresAt = Date.now() + TOKEN_TTL_MS;
    return grant.path;
  };

  return { authorizeInput, grantPath, resolveToken };
};

module.exports = { createMediaAccessService };
