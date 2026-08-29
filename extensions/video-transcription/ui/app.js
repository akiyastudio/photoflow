(() => {
  'use strict';
  const api = window.photoFlowComponent;
  const autoStart = window.VideoTranscriptionAutoStart;
  const autoStartGate = autoStart.createAutoStartGate(sessionStorage);
  const state = { context: null, selectedOperationId: '', timer: 0, startPending: false };
  const $ = selector => document.querySelector(selector);
  const rpc = (method, payload = {}) => api.rpc(method, payload);
  const applyTheme = resolvedTheme => { const dark = resolvedTheme === 'dark'; document.documentElement.classList.toggle('dark', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; };
  const notice = (message, tone = 'info') => { const node = $('#notice'); node.hidden = !message; node.textContent = message; node.dataset.tone = tone; };
  const time = seconds => { const value = Math.max(0, Number(seconds) || 0); return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`; };
  const stateLabel = value => ({ queued: '等待中', running: '识别中', completed: '已完成', partial_failure: '部分失败', failed: '失败', cancelled: '已取消', pending: '等待中' }[value] || value);
  const button = (label, action, value) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'pf-button'; node.textContent = label; node.dataset[action] = value; return node; };
  const { selectedPaths } = autoStart;

  const runAccepted = result => {
    if (result.cancelled) return;
    state.selectedOperationId = result.operationId;
    notice(result.warning || '任务已开始；关闭页面后仍会保留处理进度。', result.warning ? 'warning' : 'success');
    void rpc('transcript.operation.run.v1', { operationId: result.operationId }).catch(error => notice(error.message, 'error'));
    void refresh();
  };
  const startCurrentSelection = async ({ automatic = false, admitted = false } = {}) => {
    const context = state.context; const relativePaths = selectedPaths(context);
    if (!relativePaths.length || state.startPending || (automatic && !admitted)) return;
    state.startPending = true; $('#reprocess').disabled = true;
    try {
      notice(automatic ? '正在从当前选择创建任务…' : '正在重新处理当前选择…');
      const result = await rpc('transcript.project.start.v1', { scope: 'selected', scopeRelativePath: context.scopeRelativePath || '', relativePaths });
      runAccepted(result);
    } catch (error) { notice(error.message, 'error'); }
    finally { state.startPending = false; if (automatic) autoStartGate.finish(); $('#reprocess').disabled = !selectedPaths(state.context).length; }
  };

  const renderOperations = operations => {
    const root = $('#operations'); root.replaceChildren();
    if (!operations.length) { root.textContent = '还没有识别任务'; return; }
    operations.forEach(operation => { const node = button('', 'operation', operation.id); node.className = operation.id === state.selectedOperationId ? 'operation pf-button active' : 'operation pf-button'; const title = document.createElement('strong'); title.textContent = `${stateLabel(operation.state)} · ${operation.total} 个文件`; const detail = document.createElement('span'); detail.textContent = `${operation.succeeded} 完成 / ${operation.failed} 失败`; node.append(title, detail); root.append(node); });
  };
  const renderOperation = operation => {
    state.selectedOperationId = operation.id; $('#detail-title').textContent = `${stateLabel(operation.state)} · ${operation.total} 个文件`; $('#detail-summary').textContent = `${operation.succeeded} 完成，${operation.failed} 失败${operation.error ? ` · ${operation.error}` : ''}`;
    const actions = $('#detail-actions'); actions.replaceChildren(); if (operation.state === 'running' || operation.state === 'queued') actions.append(button('取消任务', 'cancel', operation.id)); if (['cancelled', 'failed', 'partial_failure'].includes(operation.state)) actions.append(button('从 checkpoint 恢复', 'resume', operation.id));
    const list = $('#files'); list.className = 'file-list'; list.replaceChildren();
    operation.files.forEach(file => { const row = document.createElement('div'); row.className = `file-row ${file.state}`; const identity = document.createElement('div'); const title = document.createElement('strong'); title.textContent = file.relativeName; const meta = document.createElement('span'); meta.textContent = `${stateLabel(file.state)} · ${Math.round(file.progress)}%${file.error ? ` · ${file.error}` : ''}`; identity.append(title, meta); const progress = document.createElement('progress'); progress.max = 100; progress.value = file.progress; const controls = document.createElement('div'); if (file.state === 'completed') { controls.append(button('查看', 'viewFile', file.id), button(file.output?.commitId ? '重新发布' : '发布 SRT', 'publish', file.id)); if (file.output?.commitId) controls.append(button('打开输出', 'openOutput', file.id)); } row.append(identity, progress, controls); list.append(row); });
  };
  async function refresh() { try { const listed = await rpc('transcript.operation.list.v1'); renderOperations(listed.operations || []); if (!state.selectedOperationId && listed.operations?.length) state.selectedOperationId = listed.operations[0].id; if (state.selectedOperationId) renderOperation((await rpc('transcript.operation.get.v1', { operationId: state.selectedOperationId })).operation); } catch (error) { notice(error.message, 'error'); } }
  const viewFile = async fileId => { try { const result = await rpc('transcript.file.get.v1', { fileId }); $('#segments-title').textContent = result.file.relativeName; const root = $('#segments'); root.replaceChildren(); result.segments.forEach(item => { const line = document.createElement('p'); const stamp = document.createElement('time'); stamp.textContent = `${time(item.start)} – ${time(item.end)}`; line.append(stamp, document.createTextNode(item.text)); root.append(line); }); $('#segments-dialog').showModal(); } catch (error) { notice(error.message, 'error'); } };
  const publish = async fileId => { try { const result = await rpc('transcript.output.publish.v1', { fileId }); notice(result.message, 'success'); await refresh(); } catch (error) { notice(error.message, 'error'); } };
  document.addEventListener('click', event => { const target = event.target.closest('button'); if (!target) return; if (target.dataset.operation) { state.selectedOperationId = target.dataset.operation; void refresh(); } else if (target.dataset.cancel) void rpc('transcript.operation.cancel.v1', { operationId: target.dataset.cancel }).then(refresh).catch(error => notice(error.message, 'error')); else if (target.dataset.resume) void rpc('transcript.operation.resume.v1', { operationId: target.dataset.resume }).then(runAccepted).catch(error => notice(error.message, 'error')); else if (target.dataset.viewFile) void viewFile(target.dataset.viewFile); else if (target.dataset.publish) void publish(target.dataset.publish); else if (target.dataset.openOutput) void rpc('transcript.output.open.v1', { fileId: target.dataset.openOutput }).catch(error => notice(error.message, 'error')); });
  $('#refresh').addEventListener('click', refresh); $('#reprocess').addEventListener('click', () => void startCurrentSelection());
  $('#search-form').addEventListener('submit', async event => { event.preventDefault(); const root = $('#search-results'); root.textContent = '搜索中…'; try { const result = await rpc('transcript.search.v1', { query: $('#search-input').value }); root.replaceChildren(); result.results.forEach(item => { const row = button('', 'viewFile', item.fileId); const title = document.createElement('strong'); title.textContent = `${item.relativeName} · ${time(item.start)}`; const text = document.createElement('span'); text.textContent = item.text; row.append(title, text); root.append(row); }); if (!result.results.length) root.textContent = '没有匹配字幕'; } catch (error) { root.textContent = error.message; } });
  const setContext = context => { state.context = context; applyTheme(context.resolvedTheme); const count = selectedPaths(context).length; $('#selection-summary').textContent = count ? `当前选择 ${count} 个项目条目` : '从工具栏打开的任务历史'; $('#reprocess').disabled = !count || state.startPending; $('#empty-selection').hidden = count > 0; };
  api.getContext().then(context => { setContext(context); if (autoStartGate.initial(context)) void startCurrentSelection({ automatic: true, admitted: true }); }).catch(error => notice(error.message, 'error'));
  api.onContextChange(context => { setContext(context); if (autoStartGate.contextChanged(context)) void startCurrentSelection({ automatic: true, admitted: true }); });
  api.onThemeChange(value => applyTheme(value.resolvedTheme)); api.onEvent('transcript.operation.progress.v1', () => void refresh());
  rpc('transcript.runtime.status.v1').then(result => { const node = $('#runtime-status'); node.textContent = result.ready ? `运行时就绪 · ${result.source}` : `运行时不可用 · ${result.message}`; node.dataset.tone = result.ready ? 'success' : 'danger'; });
  void refresh(); state.timer = window.setInterval(refresh, 2000); api.onDeactivate(() => window.clearInterval(state.timer)); api.onActivate(() => { window.clearInterval(state.timer); state.timer = window.setInterval(refresh, 2000); void refresh(); });
})();
