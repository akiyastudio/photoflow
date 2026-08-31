(function exposeTranscriptBrowserModel(root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.VideoTranscriptionBrowserModel = model;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';
  const fileSignature = file => [file.id, file.relativeName, file.state, Math.round(Number(file.progress) || 0), file.error || '', Number(file.segmentCount) || 0, Number(file.updatedAt) || 0, file.output?.commitId || '', file.output?.sha256 || ''].join('\u0000');
  const operationSignature = operation => operation ? [operation.id, operation.state, operation.total, operation.succeeded, operation.failed, operation.error || '', ...(operation.files || []).map(fileSignature)].join('\u0001') : '';
  const operationsSignature = operations => (operations || []).map(item => [item.id, item.state, item.total, item.succeeded, item.failed, item.updatedAt].join('\u0000')).join('\u0001');
  const operationProgress = operation => {
    const files = Array.isArray(operation?.files) ? operation.files : [];
    const total = Math.max(0, Number(operation?.total) || files.length);
    if (['completed', 'partial_failure', 'failed'].includes(operation?.state)) return 100;
    if (!total) return operation?.terminal ? 100 : 0;
    const completedProgress = files.reduce((sum, file) => {
      if (file.state === 'completed' || file.state === 'failed') return sum + 100;
      return sum + Math.max(0, Math.min(100, Number(file.progress) || 0));
    }, 0);
    return Math.max(0, Math.min(100, Math.round(completedProgress / total)));
  };
  const taskNoticeView = operation => {
    if (!operation || operation.sourceKind === 'srt-library') return null;
    const total = Math.max(0, Number(operation.total) || operation.files?.length || 0);
    const succeeded = Math.max(0, Number(operation.succeeded) || 0);
    const failed = Math.max(0, Number(operation.failed) || 0);
    const processed = Math.min(total, succeeded + failed);
    const progress = operationProgress(operation);
    const current = (operation.files || []).find(file => file.state === 'running');
    const views = {
      queued: operation.error ? { tone: 'error', title: '任务未能开始', detail: operation.error } : { tone: 'primary', title: '任务已创建，等待识别', detail: `共 ${total} 个文件，正在准备识别` },
      running: { tone: 'primary', title: '正在识别', detail: `已处理 ${processed}/${total}${current ? ` · 当前：${current.displayName || current.relativeName} · ${Math.round(Number(current.progress) || 0)}%` : ''}` },
      completed: { tone: 'success', title: '识别完成', detail: `全部 ${succeeded} 个文件识别完成，SRT 已写入视频同目录` },
      partial_failure: { tone: 'warning', title: '识别完成，部分文件失败', detail: `${succeeded} 个完成，${failed} 个失败，请查看失败文件` },
      failed: { tone: 'error', title: '识别失败', detail: `${failed || total} 个文件识别失败${operation.error ? ` · ${operation.error}` : ''}` },
      cancelled: { tone: 'warning', title: '任务已取消', detail: `已处理 ${processed}/${total}，可恢复任务继续识别` },
    };
    return { ...(views[operation.state] || { tone: 'primary', title: '任务状态已更新', detail: `${processed}/${total} 个文件已处理` }), progress, terminal: Boolean(operation.terminal) };
  };
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
  const transcriptKey = file => file ? `${file.id}\u0000${file.state}\u0000${Number(file.segmentCount) || 0}\u0000${Number(file.updatedAt) || 0}` : '';
  const formatTime = seconds => { const value = Math.max(0, Number(seconds) || 0); const hours = Math.floor(value / 3600); const minutes = Math.floor(value / 60) % 60; const secs = Math.floor(value % 60); const millis = Math.floor((value % 1) * 1000); return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`; };
  const transcriptText = segments => (segments || []).map(item => `${formatTime(item.start)} – ${formatTime(item.end)}\n${String(item.text || '').trim()}`).join('\n\n');
  const segmentKey = (fileId, seq) => `${String(fileId || '')}:${Math.max(0, Number(seq) || 0)}`;
  const boundedPage = (items, limit = 200) => (Array.isArray(items) ? items : []).slice(0, Math.min(200, Math.max(1, Number(limit) || 1)));
  return { buildTree, defaultFileId, fileSignature, operationSignature, operationsSignature, operationProgress, taskNoticeView, transcriptKey, transcriptText, formatTime, segmentKey, boundedPage };
});
