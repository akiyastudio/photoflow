const fs = require('fs');
const path = require('path');

const RECENT_CONTENT_CHANGE_MS = 2 * 60 * 1000;

// Recursive Windows watchers can report directory metadata and old-file
// attribute/access changes while a scan is merely reading the tree. Feeding
// those notifications back into another recursive scan creates a self-
// sustaining loop. Rename/create/delete events and files with a genuinely
// recent content mtime remain actionable.
const isNonContentMetadataChange = (root, changedName, eventType, fileSystem = fs, now = Date.now()) => {
  if (eventType !== 'change') return false;
  try {
    const stat = fileSystem.statSync(path.resolve(root, changedName));
    if (stat.isDirectory()) return true;
    const modifiedAt = Number(stat.mtimeMs) || 0;
    return modifiedAt > 0 && now - modifiedAt > RECENT_CONTENT_CHANGE_MS;
  } catch {
    // A path that disappeared between notification and flush may represent a
    // real deletion. Keep it so reconciliation can repair the index.
    return false;
  }
};

const filterActionableWatchEntries = (root, changedEntries, fileSystem = fs, now = Date.now()) => (changedEntries || [])
  .filter(([changedName, eventType]) => !isNonContentMetadataChange(root, changedName, eventType, fileSystem, now));

module.exports = { filterActionableWatchEntries, isNonContentMetadataChange, RECENT_CONTENT_CHANGE_MS };
