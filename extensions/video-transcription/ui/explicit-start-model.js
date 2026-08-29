(function exposeExplicitStartModel(root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.VideoTranscriptionExplicitStart = model;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';
  const selectedPaths = context => Array.isArray(context?.selectedRelativePaths)
    ? context.selectedRelativePaths.filter(value => typeof value === 'string' && value.trim())
    : [];
  const selectionKey = context => JSON.stringify([
    context?.projectId || '',
    context?.scopeRelativePath || '',
    selectedPaths(context),
  ]);

  const createExplicitStartController = ({ startProject, runOperation, onAccepted, onRunError, onChange } = {}) => {
    let context = null;
    let pending = false;
    let started = false;
    let revision = 0;
    let currentKey = '';
    const notify = () => onChange?.(controller.view());
    const controller = {
      setContext(nextContext) {
        const nextKey = selectionKey(nextContext);
        context = nextContext;
        if (nextKey !== currentKey) {
          currentKey = nextKey;
          pending = false;
          started = false;
          revision += 1;
        }
        notify();
      },
      view() {
        const count = selectedPaths(context).length;
        return {
          count,
          disabled: count === 0 || pending,
          label: count === 0
            ? '请在文件页选择视频或文件夹'
            : pending ? '正在开始…' : started ? '重新识别当前选择' : '开始识别',
        };
      },
      async start() {
        const relativePaths = selectedPaths(context);
        if (!relativePaths.length) return { accepted: false, reason: 'empty-selection' };
        if (pending) return { accepted: false, reason: 'pending' };
        const activeRevision = revision;
        const payload = { scope: 'selected', scopeRelativePath: context?.scopeRelativePath || '', relativePaths };
        pending = true;
        notify();
        try {
          const result = await startProject(payload);
          if (!result?.cancelled) {
            if (revision === activeRevision) onAccepted?.(result);
            Promise.resolve(runOperation({ operationId: result.operationId })).catch(error => {
              if (revision === activeRevision) onRunError?.(error);
            });
          }
          if (revision === activeRevision) {
            pending = false;
            started = !result?.cancelled;
            notify();
          }
          return { accepted: !result?.cancelled, result };
        } catch (error) {
          if (revision === activeRevision) {
            pending = false;
            notify();
          }
          throw error;
        }
      },
    };
    return controller;
  };

  return { selectedPaths, createExplicitStartController };
});
