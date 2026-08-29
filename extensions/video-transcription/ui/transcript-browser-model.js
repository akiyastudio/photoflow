(function exposeTranscriptBrowserModel(root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.VideoTranscriptionBrowserModel = model;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';
  const fileSignature = file => [file.id, file.relativeName, file.state, Math.round(Number(file.progress) || 0), file.error || '', Number(file.segmentCount) || 0, file.output?.commitId || '', file.output?.sha256 || ''].join('\u0000');
  const operationSignature = operation => operation ? [operation.id, operation.state, operation.total, operation.succeeded, operation.failed, operation.error || '', ...(operation.files || []).map(fileSignature)].join('\u0001') : '';
  const operationsSignature = operations => (operations || []).map(item => [item.id, item.state, item.total, item.succeeded, item.failed, item.updatedAt].join('\u0000')).join('\u0001');
  const buildTree = files => {
    const root = { type: 'folder', name: '', path: '', children: [] };
    for (const file of files || []) {
      const parts = String(file.relativeName || file.displayName || '').replace(/\\/g, '/').split('/').filter(Boolean);
      let parent = root;
      parts.forEach((part, index) => {
        if (index === parts.length - 1) parent.children.push({ type: 'file', name: part, path: parts.join('/'), file });
        else {
          const folderPath = parts.slice(0, index + 1).join('/');
          let folder = parent.children.find(item => item.type === 'folder' && item.name === part);
          if (!folder) { folder = { type: 'folder', name: part, path: folderPath, children: [] }; parent.children.push(folder); }
          parent = folder;
        }
      });
    }
    const sort = node => node.children.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'folder' ? -1 : 1).forEach(item => { if (item.type === 'folder') sort(item); });
    sort(root); return root;
  };
  const defaultFileId = (files, current = '') => (files || []).some(file => file.id === current) ? current : (files || []).find(file => file.state === 'completed')?.id || (files || [])[0]?.id || '';
  const transcriptKey = file => file ? `${file.id}\u0000${file.state}\u0000${Number(file.segmentCount) || 0}` : '';
  const formatTime = seconds => { const value = Math.max(0, Number(seconds) || 0); const hours = Math.floor(value / 3600); const minutes = Math.floor(value / 60) % 60; const secs = Math.floor(value % 60); const millis = Math.floor((value % 1) * 1000); return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`; };
  const transcriptText = segments => (segments || []).map(item => `${formatTime(item.start)} – ${formatTime(item.end)}\n${String(item.text || '').trim()}`).join('\n\n');
  const segmentKey = (fileId, seq) => `${String(fileId || '')}:${Math.max(0, Number(seq) || 0)}`;
  const boundedPage = (items, limit = 200) => (Array.isArray(items) ? items : []).slice(0, Math.min(200, Math.max(1, Number(limit) || 1)));
  return { buildTree, defaultFileId, fileSignature, operationSignature, operationsSignature, transcriptKey, transcriptText, formatTime, segmentKey, boundedPage };
});
