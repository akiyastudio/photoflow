const fs = require('fs');
const path = require('path');

const RECENT_CONTENT_CHANGE_MS = 2 * 60 * 1000;
const MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif', '.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);

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

const entryEventType = detail => typeof detail === 'string' ? detail : detail?.eventType === 'rename' ? 'rename' : 'change';

const recordActionableWatchEntry = (changes, knownEntries, root, changedName, eventType, fileSystem = fs) => {
  const previous = knownEntries.get(changedName);
  const existing = changes.get(changedName);
  let observed = null;
  try {
    const stat = fileSystem.statSync(path.resolve(root, changedName));
    observed = { kind: stat.isDirectory() ? 'directory' : 'file', extension: path.extname(changedName).toLocaleLowerCase() };
    knownEntries.set(changedName, observed);
  } catch { /* deletion/offline: retain the last observed shape */ }
  changes.set(changedName, {
    eventType: existing?.eventType === 'rename' || eventType === 'rename' ? 'rename' : 'change',
    previousKind: existing?.previousKind || previous?.kind || observed?.kind,
    previousExtension: existing?.previousExtension || previous?.extension || observed?.extension || path.extname(changedName).toLocaleLowerCase(),
  });
};

const forgetMissingWatchChanges = (knownEntries, root, changes) => {
  for (const change of changes || []) if (change.kind === 'missing') knownEntries.delete(path.relative(root, change.path));
};

const filterActionableWatchEntries = (root, changedEntries, fileSystem = fs, now = Date.now()) => (changedEntries || [])
  .filter(([changedName, detail]) => !isNonContentMetadataChange(root, changedName, entryEventType(detail), fileSystem, now));

const describeActionableWatchChanges = (root, changedEntries, fileSystem = fs, now = Date.now()) => (
  filterActionableWatchEntries(root, changedEntries, fileSystem, now).map(([changedName, detail]) => {
    const absolutePath = path.resolve(root, changedName);
    const eventType = entryEventType(detail);
    const history = typeof detail === 'object' && detail ? {
      previousKind: detail.previousKind,
      previousExtension: detail.previousExtension,
      knownMedia: detail.knownMedia === true,
    } : {};
    try {
      const stat = fileSystem.statSync(absolutePath);
      return {
        path: absolutePath, eventType, kind: stat.isDirectory() ? 'directory' : 'file',
        observedMtimeMs: Number(stat.mtimeMs) || 0, observedSize: stat.isFile() ? Number(stat.size) || 0 : undefined,
        ...history,
      };
    } catch {
      return { path: absolutePath, eventType, kind: 'missing', ...history };
    }
  })
);

const isMediaRelevantChange = change => {
  const currentExtension = path.extname(String(change?.path || '')).toLocaleLowerCase();
  const previousExtension = String(change?.previousExtension || '').toLocaleLowerCase();
  if (change?.kind === 'directory') return true;
  if (change?.kind === 'file') return MEDIA_EXTENSIONS.has(currentExtension);
  if (change?.kind !== 'missing') return false;
  return change.previousKind === 'directory' || change.knownMedia === true
    || MEDIA_EXTENSIONS.has(currentExtension) || MEDIA_EXTENSIONS.has(previousExtension);
};

module.exports = { describeActionableWatchChanges, filterActionableWatchEntries, forgetMissingWatchChanges, isMediaRelevantChange, isNonContentMetadataChange, recordActionableWatchEntry, MEDIA_EXTENSIONS, RECENT_CONTENT_CHANGE_MS };
