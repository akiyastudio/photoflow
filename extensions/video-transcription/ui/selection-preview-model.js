(function exposeSelectionPreviewModel(root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.VideoTranscriptionSelectionPreview = model;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';
  const normalizedPaths = context => Array.isArray(context?.selectedRelativePaths)
    ? context.selectedRelativePaths.filter(value => typeof value === 'string' && value.trim()).map(value => value.replace(/\\/g, '/')) : [];
  const payloadFor = context => ({ scopeRelativePath: String(context?.scopeRelativePath || ''), relativePaths: normalizedPaths(context) });
  const contextKey = context => JSON.stringify([String(context?.scopeRelativePath || ''), ...normalizedPaths(context)]);
  const previewFiles = result => (Array.isArray(result?.files) ? result.files : []).map((item, index) => {
    const relativeName = String(item?.relativeName || '').replace(/\\/g, '/');
    return { id: `selection-preview:${index}:${relativeName}`, displayName: String(item?.displayName || relativeName.split('/').pop() || ''), relativeName, state: 'preview', progress: 0, error: '', preview: true };
  }).filter(file => file.relativeName);
  const buildTree = files => {
    const root = { type: 'folder', name: '', path: '', children: [] };
    for (const file of files || []) {
      const parts = file.relativeName.split('/').filter(Boolean); let parent = root;
      parts.forEach((part, index) => {
        if (index === parts.length - 1) parent.children.push({ type: 'file', name: part, path: file.relativeName, file });
        else { const folderPath = parts.slice(0, index + 1).join('/'); let folder = parent.children.find(item => item.type === 'folder' && item.name === part); if (!folder) { folder = { type: 'folder', name: part, path: folderPath, children: [] }; parent.children.push(folder); } parent = folder; }
      });
    }
    const sort = node => node.children.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'folder' ? -1 : 1).forEach(item => { if (item.type === 'folder') sort(item); });
    sort(root); return root;
  };
  const createController = ({ load, onChange }) => {
    let token = 0; let key = '';
    const setContext = context => {
      const nextKey = contextKey(context); if (nextKey === key) return; key = nextKey; const requestToken = ++token; const payload = payloadFor(context);
      if (!payload.relativePaths.length) { onChange({ state: 'empty-selection', files: [], total: 0, limitReached: false }); return; }
      onChange({ state: 'loading', files: [], total: 0, limitReached: false });
      Promise.resolve(load(payload)).then(result => { if (requestToken !== token) return; const files = previewFiles(result); onChange({ state: files.length ? 'ready' : 'empty', files, total: Number(result?.total) || files.length, limit: Number(result?.limit) || 2000, limitReached: result?.limitReached === true }); })
        .catch(error => { if (requestToken === token) onChange({ state: 'error', files: [], total: 0, limitReached: false, error: String(error?.message || error || '无法读取当前选择') }); });
    };
    return { setContext, invalidate: () => { token += 1; key = ''; } };
  };
  return { normalizedPaths, payloadFor, previewFiles, buildTree, createController };
});
