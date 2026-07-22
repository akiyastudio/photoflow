const fs = require('fs');
const path = require('path');

const capturePathIdentity = async filePath => {
  const stat = await fs.promises.stat(filePath, { bigint: true });
  return {
    path: path.resolve(filePath),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    modifiedNs: stat.mtimeNs.toString(),
    directory: stat.isDirectory(),
  };
};

const samePathIdentity = async (filePath, expected) => {
  if (!expected) return false;
  try {
    const current = await capturePathIdentity(filePath);
    if (expected.device !== '0' && expected.inode !== '0' && current.device !== '0' && current.inode !== '0') {
      return current.device === expected.device && current.inode === expected.inode && current.directory === expected.directory;
    }
    return current.size === expected.size && current.modifiedNs === expected.modifiedNs && current.directory === expected.directory;
  } catch { return false; }
};

const addUndoIdentities = async operation => {
  const candidates = operation.kind === 'remove-created'
    ? operation.paths || []
    : operation.kind === 'project' || operation.kind === 'folder'
      ? [operation.destination]
      : ['files', 'move', 'external-move'].includes(operation.kind)
        ? (operation.moves || []).map(move => move.destination)
        : operation.kind === 'broll-import'
          ? [...(operation.createdPaths || []), ...(operation.moves || []).map(move => move.destination)]
          : [];
  const identities = {};
  for (const candidate of candidates) {
    try { identities[path.resolve(candidate)] = await capturePathIdentity(candidate); }
    catch { /* the undo handler will reject missing targets */ }
  }
  return { ...operation, identities };
};

const assertUndoIdentity = async (operation, filePath) => {
  const resolved = path.resolve(filePath);
  if (!await samePathIdentity(resolved, operation.identities?.[resolved])) {
    const error = new Error(`“${path.basename(resolved)}”已被替换或修改，无法安全撤销`);
    error.code = 'UNDO_IDENTITY_MISMATCH';
    throw error;
  }
};

module.exports = { capturePathIdentity, samePathIdentity, addUndoIdentities, assertUndoIdentity };
