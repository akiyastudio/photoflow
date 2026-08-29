(function exposeAutoStartModel(root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.VideoTranscriptionAutoStart = model;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';
  const selectedPaths = context => Array.isArray(context?.selectedRelativePaths) ? context.selectedRelativePaths.filter(value => typeof value === 'string' && value.trim()) : [];
  const isSelectionEntry = context => context?.surface === 'project.contextAction' && selectedPaths(context).length > 0;
  const contextKey = context => `photoflow.video-transcription.autostart:${context?.projectId || ''}:${context?.sourcePageId || ''}:${context?.scopeRelativePath || ''}:${selectedPaths(context).map(value => value.toLocaleLowerCase('en-US')).sort().join('|')}`;
  const createAutoStartGate = storage => {
    let pending = false;
    const begin = () => { if (pending) return false; pending = true; return true; };
    return {
      initial(context) {
        if (!isSelectionEntry(context)) return false;
        const key = contextKey(context);
        if (storage.getItem(key) === 'started') return false;
        storage.setItem(key, 'started');
        return begin();
      },
      contextChanged(context) {
        if (!isSelectionEntry(context)) return false;
        storage.setItem(contextKey(context), 'started');
        return begin();
      },
      finish() { pending = false; },
    };
  };
  return { selectedPaths, isSelectionEntry, contextKey, createAutoStartGate };
});
