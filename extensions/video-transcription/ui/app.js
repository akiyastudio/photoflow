(() => {
  'use strict';
  const api = window.photoFlowComponent;
  const explicitStart = window.VideoTranscriptionExplicitStart;
  const selectionPreview = window.VideoTranscriptionSelectionPreview;
  const browser = window.VideoTranscriptionBrowserModel;
  const state = { context: null, operationId: '', operation: null, fileId: '', viewMode: 'single', sourceMode: 'selection', selectionContextKey: '', allCursor: '', transcriptRenderToken: 0, navigationToken: 0, searchToken: 0, searchQuery: '', searchCursor: '', operations: [], operationsSignature: '', operationSignature: '', transcriptCache: new Map(), selectionPreview: { state: 'idle', files: [], total: 0, limitReached: false } };
  const $ = selector => document.querySelector(selector);
  const rpc = (method, payload = {}) => api.rpc(method, payload);
  const applyTheme = resolvedTheme => { const dark = resolvedTheme === 'dark'; document.documentElement.classList.toggle('dark', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; };
  const notice = (message, tone = 'info') => { const node = $('#notice'); node.hidden = !message; node.textContent = message; node.dataset.tone = tone; };
  const shortTime = seconds => { const value = Math.max(0, Number(seconds) || 0); return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`; };
  const stateLabel = value => ({ queued: '等待中', running: '识别中', completed: '已完成', partial_failure: '部分失败', failed: '失败', cancelled: '已取消', pending: '等待中' }[value] || value);
  const button = (label, action, value, className = 'pf-button') => { const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = label; node.dataset[action] = value; return node; };
  const renderSegments = (segments, { highlightSeq = 0, includeFile = false } = {}) => {
    const root = $('#transcript-list'); root.replaceChildren(); let previousFile = '';
    for (const item of browser.boundedPage(segments, 200)) {
      if (includeFile && item.fileId !== previousFile) { const heading = document.createElement('h3'); heading.className = 'transcript-file-heading'; heading.textContent = item.relativeName; root.append(heading); previousFile = item.fileId; }
      const row = document.createElement('div'); row.className = 'transcript-segment'; row.tabIndex = -1; row.id = `segment-${browser.segmentKey(item.fileId || state.fileId, item.seq)}`; row.dataset.seq = String(item.seq);
      const time = document.createElement('time'); time.textContent = `${browser.formatTime(item.start)} – ${browser.formatTime(item.end)}`;
      const copy = document.createElement('span'); copy.textContent = String(item.text || '').trim(); row.append(time, copy);
      if (Number(item.seq) === Number(highlightSeq)) row.classList.add('highlighted'); root.append(row);
    }
    root.dataset.state = segments.length ? 'ready' : 'empty';
    const highlighted = root.querySelector('.highlighted'); if (highlighted) { highlighted.scrollIntoView({ block: 'center' }); highlighted.focus({ preventScroll: true }); }
  };
  const { selectedPaths } = explicitStart;

  let startView = { count: 0, disabled: true, label: '请在文件页选择视频或文件夹' };
  const renderStart = view => { startView = view; document.querySelectorAll('#reprocess,[data-selection-action]').forEach(node => { node.textContent = view.label; node.disabled = view.disabled; }); };
  const startController = explicitStart.createExplicitStartController({
    startProject: payload => rpc('transcript.project.start.v1', payload),
    runOperation: payload => rpc('transcript.operation.run.v1', payload),
    onAccepted: result => { state.sourceMode = 'operation'; state.operationId = result.operationId; state.operationsSignature = ''; notice(result.warning || '任务已开始；关闭页面后仍会保留处理进度。', result.warning ? 'warning' : 'success'); coordinator.request({ immediate: true }); },
    onRunError: error => notice(error.message, 'error'), onChange: renderStart,
  });
  const startCurrentSelection = async () => {
    notice('正在从当前选择创建任务…');
    try { const outcome = await startController.start(); if (!outcome.accepted && outcome.reason === 'empty-selection') notice('请在文件页选择视频或文件夹', 'warning'); }
    catch (error) { notice(error.message, 'error'); }
  };

  const renderOperations = operations => {
    state.operations = operations;
    const hasSelection = selectedPaths(state.context).length > 0;
    const preview = state.selectionPreview;
    const signature = [browser.operationsSignature(operations), state.sourceMode, hasSelection, preview.state, preview.total, preview.limitReached].join('\u0002');
    if (signature === state.operationsSignature) return;
    state.operationsSignature = signature;
    const select = $('#operation-select'); select.replaceChildren();
    if (hasSelection) { const option = document.createElement('option'); option.value = '__current_selection__'; option.textContent = preview.state === 'ready' ? `当前选择 · ${preview.total} 个视频` : preview.state === 'empty' ? '当前选择 · 没有视频' : preview.state === 'error' ? '当前选择 · 读取失败' : '当前选择 · 正在读取'; select.append(option); }
    if (!operations.length && !hasSelection) { const option = document.createElement('option'); option.value = ''; option.textContent = '还没有识别任务'; select.append(option); select.disabled = true; return; }
    select.disabled = false;
    operations.forEach(operation => { const option = document.createElement('option'); option.value = operation.id; option.textContent = operation.sourceKind === 'srt-library' ? `全部 SRT · ${operation.total} 个文件` : `${stateLabel(operation.state)} · ${operation.total} 个文件 · ${new Date(operation.createdAt).toLocaleString()}`; select.append(option); });
    select.value = state.sourceMode === 'selection' && hasSelection ? '__current_selection__' : state.operationId;
  };
  const renderTreeNode = (node, root) => {
    if (node.type === 'folder') {
      const details = document.createElement('details'); details.className = 'tree-folder'; details.open = !state.fileId || state.operation?.files?.find(file => file.id === state.fileId)?.relativeName.startsWith(`${node.path}/`);
      const summary = document.createElement('summary'); summary.textContent = node.name; details.append(summary);
      const children = document.createElement('div'); children.className = 'tree-children'; node.children.forEach(child => renderTreeNode(child, children)); details.append(children); root.append(details); return;
    }
    const file = node.file; const item = button('', 'selectFile', file.id, `tree-file ${file.state}${file.id === state.fileId ? ' active' : ''}`);
    const name = document.createElement('span'); name.className = 'tree-file-name'; name.textContent = node.name;
    const meta = document.createElement('span'); meta.className = 'tree-file-meta'; meta.textContent = `${stateLabel(file.state)}${['running', 'queued', 'pending'].includes(file.state) ? ` · ${Math.round(file.progress)}%` : ''}${file.error ? ` · ⚠ ${file.error}` : ''}`;
    item.append(name, meta); root.append(item);
  };
  const renderPreviewTreeNode = (node, root) => {
    if (node.type === 'folder') {
      const details = document.createElement('details'); details.className = 'tree-folder selection-preview-folder'; details.open = true;
      const summary = document.createElement('summary'); summary.textContent = node.name; details.append(summary);
      const children = document.createElement('div'); children.className = 'tree-children'; node.children.forEach(child => renderPreviewTreeNode(child, children)); details.append(children); root.append(details); return;
    }
    const item = document.createElement('div'); item.className = 'tree-file selection-preview-file'; item.title = node.file.relativeName;
    const name = document.createElement('span'); name.className = 'tree-file-name'; name.textContent = node.name;
    const meta = document.createElement('span'); meta.className = 'tree-file-meta'; meta.textContent = '待识别'; item.append(name, meta); root.append(item);
  };
  const renderSelectionPreview = () => {
    if (state.sourceMode !== 'selection') return;
    const preview = state.selectionPreview; const tree = $('#file-tree'); tree.replaceChildren();
    if (preview.state === 'loading' || preview.state === 'idle') { tree.textContent = '正在读取当前选择中的视频…'; $('#operation-summary').textContent = '正在递归扫描当前选择'; return; }
    if (preview.state === 'error') { const message = document.createElement('div'); message.className = 'selection-preview-message error'; message.textContent = `读取当前选择失败：${preview.error}`; tree.append(message); $('#operation-summary').textContent = '当前选择预览不可用'; return; }
    if (preview.state === 'empty-selection') { tree.textContent = '还没有识别任务'; $('#operation-summary').textContent = '项目内的处理历史'; return; }
    if (preview.state === 'empty') { tree.textContent = '当前选择中没有可处理的视频文件'; $('#operation-summary').textContent = '未找到支持的视频'; return; }
    const model = selectionPreview.buildTree(preview.files); model.children.forEach(node => renderPreviewTreeNode(node, tree));
    $('#operation-summary').textContent = `当前选择 · 将处理 ${preview.total} 个视频${preview.limitReached ? ` · 已达到 ${preview.limit || 2000} 个预览上限` : ''}`;
  };
  const previewController = selectionPreview.createController({ load: payload => rpc('transcript.selection.preview.v1', payload), onChange: preview => { state.selectionPreview = preview; state.operationsSignature = ''; renderOperations(state.operations); renderSelectionPreview(); } });
  const renderTranscript = async (file, highlightSeq = 0, cursor = '0') => {
    const renderToken = ++state.transcriptRenderToken;
    state.viewMode = 'single'; $('#browse-all').textContent = '浏览全部';
    const title = $('#transcript-title'); const status = $('#transcript-status'); const text = $('#transcript-list'); const actions = $('#file-actions'); actions.replaceChildren();
    if (!file) {
      const paths = selectedPaths(state.context);
      text.replaceChildren(); text.dataset.state = 'empty';
      if (!state.operationId && paths.length) {
        title.textContent = '当前选择已就绪'; status.textContent = `将递归查找 ${paths.length} 个所选条目中的视频`;
        const ready = document.createElement('div'); ready.className = 'selection-ready';
        const heading = document.createElement('strong'); heading.textContent = '点击后开始识别';
        const summary = document.createElement('div'); summary.className = 'selection-ready-copy'; summary.textContent = paths.length === 1 ? paths[0] : `${paths.slice(0, 2).join('、')}${paths.length > 2 ? ` 等 ${paths.length} 个条目` : ''}`;
        const action = button(startView.label, 'selectionAction', '', 'pf-button pf-button-primary'); action.disabled = startView.disabled;
        ready.append(heading, summary, action); text.append(ready); return;
      }
      title.textContent = '选择一个文件'; status.textContent = '从左侧目录选择文件'; return;
    }
    title.textContent = file.relativeName; status.textContent = `${stateLabel(file.state)}${file.error ? ` · ${file.error}` : ''}`;
    if (file.state === 'completed') actions.append(button('打开 SRT', 'openOutput', file.id));
    if (file.state !== 'completed') { text.textContent = file.error || `${stateLabel(file.state)}，识别完成后可查看文字。`; text.dataset.state = 'empty'; return; }
    const key = `${browser.transcriptKey(file)}\u0000${cursor}\u0000${highlightSeq}`; text.textContent = '正在读取识别文字…'; text.dataset.state = 'loading';
    let pending = state.transcriptCache.get(key);
    if (!pending) { pending = rpc('transcript.file.get.v1', { fileId: file.id, cursor, targetSeq: highlightSeq, pageSize: 200 }); state.transcriptCache.set(key, pending); }
    try {
      const result = await pending;
      const current = state.operation?.files?.find(item => item.id === file.id);
      if (renderToken !== state.transcriptRenderToken || state.fileId !== file.id || (current && !key.startsWith(browser.transcriptKey(current)))) return;
      renderSegments((result.segments || []).map(item => ({ ...item, fileId: file.id })), { highlightSeq });
      if (!result.segments?.length) text.textContent = '识别完成，但没有文字片段。';
    } catch (error) { state.transcriptCache.delete(key); if (renderToken === state.transcriptRenderToken && state.fileId === file.id) { text.textContent = error.message; text.dataset.state = 'error'; } }
  };
  const selectFile = (fileId, highlightSeq = 0) => {
    state.fileId = fileId; const file = state.operation?.files?.find(item => item.id === fileId);
    document.querySelectorAll('.tree-file').forEach(node => node.classList.toggle('active', node.dataset.selectFile === fileId));
    return renderTranscript(file, highlightSeq);
  };
  const renderAllTranscript = async () => {
    if (!state.operationId) return;
    const renderToken = ++state.transcriptRenderToken; const operationId = state.operationId;
    state.viewMode = 'all'; state.allCursor = ''; $('#browse-all').textContent = '返回单文件'; $('#file-actions').replaceChildren();
    const root = $('#transcript-list'); const status = $('#transcript-status');
    $('#transcript-title').textContent = '全部字幕'; status.textContent = '正在读取全部字幕…'; root.textContent = ''; root.dataset.state = 'loading';
    const output = document.createElement('pre'); output.className = 'all-transcript-text'; root.append(output);
    const textNode = document.createTextNode(''); output.append(textNode);
    let cursor = ''; let previousFile = ''; let loaded = 0;
    try {
      do {
        const result = await rpc('transcript.operation.transcript.page.v1', { operationId, cursor, pageSize: 200 });
        if (renderToken !== state.transcriptRenderToken || state.viewMode !== 'all' || state.operationId !== operationId || result.operationId !== operationId) return;
        let chunk = '';
        for (const item of result.items || []) {
          if (item.fileId !== previousFile) { if (chunk || loaded) chunk += '\n'; chunk += `${item.relativeName}\n\n`; previousFile = item.fileId; }
          chunk += `${browser.formatTime(item.start)} – ${browser.formatTime(item.end)}\n${String(item.text || '').trim()}\n\n`;
        }
        textNode.appendData(chunk); loaded += result.items?.length || 0; root.dataset.state = loaded ? 'ready' : 'loading';
        status.textContent = result.page?.nextCursor ? `正在读取全部字幕…已载入 ${loaded} 条` : `已载入全部 ${loaded} 条字幕`;
        cursor = result.page?.nextCursor || '';
      } while (cursor);
      if (!loaded) { output.remove(); root.textContent = '当前任务还没有可浏览的字幕。'; root.dataset.state = 'empty'; status.textContent = '当前任务还没有可浏览的字幕'; }
    } catch (error) { if (renderToken === state.transcriptRenderToken && state.viewMode === 'all' && state.operationId === operationId) { root.textContent = `读取全部字幕失败：${error.message}`; root.dataset.state = 'error'; status.textContent = '未能完整载入全部字幕'; } }
  };
  const renderOperation = (operation, { skipTranscript = false } = {}) => {
    const signature = browser.operationSignature(operation);
    if (signature === state.operationSignature) return;
    state.operationSignature = signature; state.operation = operation; state.operationId = operation.id; $('#operation-select').value = operation.id;
    $('#operation-summary').textContent = `${stateLabel(operation.state)} · ${operation.succeeded} 完成 / ${operation.failed} 失败 / ${operation.total} 总计${operation.error ? ` · ${operation.error}` : ''}`;
    const actions = $('#operation-actions'); actions.replaceChildren();
    if (operation.state === 'running' || operation.state === 'queued') actions.append(button('取消任务', 'cancel', operation.id));
    if (['cancelled', 'failed', 'partial_failure'].includes(operation.state)) actions.append(button('从 checkpoint 恢复', 'resume', operation.id));
    const tree = $('#file-tree'); tree.replaceChildren(); const model = browser.buildTree(operation.files); model.children.forEach(node => renderTreeNode(node, tree));
    if (!operation.files.length) tree.textContent = '这个任务没有文件';
    state.fileId = browser.defaultFileId(operation.files, state.fileId); if (!skipTranscript) { if (state.viewMode === 'all') void renderAllTranscript(); else void selectFile(state.fileId); }
  };
  async function refresh() {
    try {
      const listed = await rpc('transcript.operation.list.v1'); const operations = listed.operations || [];
      if (state.sourceMode === 'selection' && selectedPaths(state.context).length) { state.operationId = ''; state.operation = null; state.operationSignature = ''; renderOperations(operations); renderSelectionPreview(); void renderTranscript(null); return; }
      if (!state.operationId || !operations.some(item => item.id === state.operationId)) state.operationId = operations[0]?.id || '';
      renderOperations(operations);
      if (!state.operationId) { state.operation = null; state.operationSignature = ''; renderSelectionPreview(); void renderTranscript(null); return; }
      const detail = await rpc('transcript.operation.get.v1', { operationId: state.operationId }); renderOperation(detail.operation);
    } catch (error) { notice(error.message, 'error'); }
  }
  const coordinator = window.VideoTranscriptionRefreshCoordinator.createRefreshCoordinator({ refresh, debounceMs: 400, pollMs: 3000 });
  const runAccepted = result => { if (result.cancelled) return; state.sourceMode = 'operation'; state.operationId = result.operationId; notice(result.warning || '任务已恢复。', result.warning ? 'warning' : 'success'); void rpc('transcript.operation.run.v1', { operationId: result.operationId }).catch(error => notice(error.message, 'error')); coordinator.request({ immediate: true }); };
  const viewSearchFile = async item => { const navigationToken = ++state.navigationToken; try {
    let detail = null; if (state.operationId !== item.operationId) detail = await rpc('transcript.operation.get.v1', { operationId: item.operationId }); if (navigationToken !== state.navigationToken) return;
    state.viewMode = 'single'; state.sourceMode = 'operation'; if (detail) { state.operationId = item.operationId; state.operationSignature = ''; state.fileId = item.fileId; renderOperation(detail.operation, { skipTranscript: true }); }
    if (navigationToken !== state.navigationToken) return; await selectFile(item.fileId, item.seq); if (navigationToken !== state.navigationToken) return; $('#operation-select').value = item.operationId;
  } catch (error) { if (navigationToken === state.navigationToken) notice(error.message, 'error'); } };
  document.addEventListener('click', event => { const target = event.target.closest('button'); if (!target) return; if (target.dataset.selectionAction !== undefined) void startCurrentSelection(); else if (target.dataset.selectFile) { ++state.navigationToken; selectFile(target.dataset.selectFile); } else if (target.dataset.cancel) void rpc('transcript.operation.cancel.v1', { operationId: target.dataset.cancel }).then(() => coordinator.request({ immediate: true })).catch(error => notice(error.message, 'error')); else if (target.dataset.resume) void rpc('transcript.operation.resume.v1', { operationId: target.dataset.resume }).then(runAccepted).catch(error => notice(error.message, 'error')); else if (target.dataset.openOutput) void rpc('transcript.output.open.v1', { fileId: target.dataset.openOutput }).catch(error => notice(error.message, 'error')); });
  $('#operation-select').addEventListener('change', event => { ++state.navigationToken; state.fileId = ''; state.viewMode = 'single'; if (event.target.value === '__current_selection__') { state.sourceMode = 'selection'; state.operationId = ''; state.operation = null; state.operationSignature = ''; state.operationsSignature = ''; renderOperations(state.operations); renderSelectionPreview(); void renderTranscript(null); return; } state.sourceMode = 'operation'; state.operationId = event.target.value; state.operationSignature = ''; state.operationsSignature = ''; coordinator.request({ immediate: true }); });
  $('#refresh').addEventListener('click', () => coordinator.request({ immediate: true })); $('#reprocess').addEventListener('click', () => void startCurrentSelection());
  $('#browse-all').addEventListener('click', () => { ++state.navigationToken; state.viewMode === 'all' ? void selectFile(state.fileId) : void renderAllTranscript(); });
  const loadSearch = async ({ query, cursor = '', append = false }) => { const searchToken = ++state.searchToken; const root = $('#search-results'); const more = $('#search-more'); more.disabled = true; if (!append) root.textContent = '搜索中…'; try { const result = await rpc('transcript.search.v1', { query, cursor, limit: 50 }); if (searchToken !== state.searchToken) return; if (!append) root.replaceChildren(); result.results.forEach(item => { const row = button('', 'searchFile', item.fileId); row.addEventListener('click', () => void viewSearchFile(item)); const title = document.createElement('strong'); title.textContent = `${item.relativeName} · ${shortTime(item.start)}`; const text = document.createElement('span'); text.textContent = item.text; row.append(title, text); root.append(row); }); if (!append && !result.results.length) root.textContent = '没有匹配字幕'; state.searchQuery = result.query; state.searchCursor = result.page?.nextCursor || ''; more.hidden = !state.searchCursor; } catch (error) { if (searchToken === state.searchToken) { if (!append) root.textContent = error.message; else notice(error.message, 'error'); } } finally { if (searchToken === state.searchToken) more.disabled = false; } };
  $('#search-form').addEventListener('submit', event => { event.preventDefault(); state.searchCursor = ''; void loadSearch({ query: $('#search-input').value, append: false }); });
  $('#search-more').addEventListener('click', () => { if (state.searchCursor) void loadSearch({ query: state.searchQuery, cursor: state.searchCursor, append: true }); });
  const setContext = context => { const selectionKey = JSON.stringify(selectionPreview.payloadFor(context)); const changed = selectionKey !== state.selectionContextKey; state.selectionContextKey = selectionKey; state.context = context; applyTheme(context.resolvedTheme); startController.setContext(context); if (changed && selectedPaths(context).length) { state.sourceMode = 'selection'; state.operationId = ''; state.operation = null; state.operationSignature = ''; state.operationsSignature = ''; } previewController.setContext(context); const count = selectedPaths(context).length; $('#selection-summary').textContent = `当前选择 ${count} 个条目`; $('#empty-selection').hidden = count > 0; if (state.sourceMode === 'selection') { renderOperations(state.operations); renderSelectionPreview(); void renderTranscript(null); } };
  api.getContext().then(context => setContext(context)).catch(error => notice(error.message, 'error')); api.onContextChange(context => setContext(context));
  api.onThemeChange(value => applyTheme(value.resolvedTheme)); api.onEvent('transcript.operation.progress.v1', () => coordinator.event());
  rpc('transcript.runtime.status.v1').then(result => { const node = $('#runtime-status'); node.textContent = result.ready ? '本地识别可用' : '本地识别不可用'; node.title = result.ready ? '' : result.message; node.dataset.tone = result.ready ? 'success' : 'danger'; }).catch(() => { $('#runtime-status').textContent = '本地识别不可用'; });
  api.onDeactivate(() => coordinator.deactivate()); api.onActivate(() => coordinator.activate()); coordinator.activate();
})();
