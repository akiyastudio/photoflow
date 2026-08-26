const assert = require('assert');
// Plugin-owned regression test.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manager = read('renderer/src/legacy/TeamRetouchManager.tsx');
const people = read('renderer/src/legacy/PersonIdentityManager.tsx');
const comparison = read('renderer/src/legacy/ImageComparisonView.tsx');
const adapter = read('renderer/src/legacy/legacy-api.ts');
const entry = read('renderer/src/legacy-main.tsx');
const modernEntry = read('renderer/src/main.tsx');
const settingsEntry = read('renderer/src/settings-main.tsx');
const settingsContent = read('renderer/src/team-settings-content.tsx');
const settingsHtml = read('renderer/settings.html');
const html = read('renderer/index.html');
const legacyStyle = read('renderer/src/legacy-style.css');
const settingsStyle = read('renderer/src/settings-style.css');
const style = read('renderer/src/legacy-style.css');
const compactStyle = style.replace(/\s+/g, '');
const manifest = JSON.parse(read('component.template.json'));
const service = read('service.cjs');
for (const [source, file] of [[entry, 'legacy-main.tsx'], [modernEntry, 'main.tsx'], [settingsEntry, 'settings-main.tsx'], [manager, 'TeamRetouchManager.tsx'], [people, 'PersonIdentityManager.tsx'], [settingsContent, 'team-settings-content.tsx']]) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = node => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['notify', 'onNotice'].includes(node.expression.text)) assert(node.arguments.length >= 2, `${file} notification calls must pass an explicit tone`); ts.forEachChild(node, visit); };
  visit(parsed);
}

assert(html.includes('/src/legacy-main.tsx'), 'packaged renderer must enter the source-faithful legacy migration');
assert(!manager.includes('legacy-photo-card') && !people.includes('legacy-photo-card'), 'legacy page must not be replaced by a hand-built lookalike');
for (const marker of ['FullscreenImageViewer', 'ImageZoomButton', 'PatchPreview', 'IdentitySubjectThumb', 'InteractiveCropEditor', 'IdentityPicker', 'onPointerMove']) assert(manager.includes(marker), `detection/identity migration lost ${marker}`);
for (const copy of ['点击人物框或人物行确认身份，可应用到整组。', '自动标记候选', '调整范围', '全窗口浏览图片']) assert(manager.includes(copy), `legacy detection interaction copy missing: ${copy}`);
assert(!manager.includes('正在读取整个项目') && manager.includes('正在读取团片历史中的人物与工作图'), 'history manager loading copy must reflect registered-history scope');
for (const marker of ['WorkflowReturnReviewDialog', 'moveWorkflowIdentityPointerDrag', 'toggleSameWeekIdentity', 'generateWorkflow', 'mergeCompletedPhotos', 'TeamOutputProgressPicker']) assert(people.includes(marker), `workflow migration lost ${marker}`);
for (const copy of ['任务分配', '接力进度', '审核输出', '个批次', '人跨周']) assert(people.includes(copy), `four-stage workflow copy missing: ${copy}`);
for (const copy of ['默认自动排期', '高级排期', '批量导入返图', '合并前阻断清单']) assert(people.includes(copy), `four-stage interaction missing: ${copy}`);
assert(people.includes('modificationAssessment.label'), 'return evidence label must come from the tested progressive-enhancement model');
assert(people.includes('data-relay-chains') && people.includes('relayChainForItems') && people.includes('当前持有人'), 'relay stage must render semantic handoff chains');
assert(people.includes('data-return-evidence') && people.includes('returnModificationAssessment') && people.includes('returnMatchAssessment'), 'return review must separate matching and modification evidence');
assert(manager.includes('data-manual-crop-warning') && manager.includes('需要人工调整裁剪范围') && manager.includes('当前为整幅工作图') && manager.includes('旧数据缺少 generation 元数据'), 'generation crop decisions must be prominent and degrade explicitly for old data');
for (const hierarchy of ['workflow-board-view', 'workflow-person-lane', 'workflow-person-summary', 'workflow-task-strip', 'workflow-task-card', 'workflow-task-thumbnail']) assert(people.includes(hierarchy), `workflow DOM hierarchy missing: ${hierarchy}`);
assert(people.includes('workspaceLoadError') && people.includes('重新读取团片历史') && people.includes('workspaceLoadSequenceRef'), 'workflow history load must terminate on error, expose retry, and reject stale results');
for (const mode of ['side-by-side', 'split', 'overlay', 'blink', 'difference']) assert(comparison.includes(`'${mode}'`), `return comparison lost ${mode} mode`);
assert(manager.includes('aria-label="团片协作设置"') && people.includes('aria-label="团片协作设置"') && entry.includes('TeamSettingsDialog'), 'historic close location must open in-component settings');
assert(manager.includes('onClick={onOpenSettings}') && !manager.includes('if (!next.length) onClose();') && manager.includes('当前项目没有团片协作图片'), 'settings entry and empty-list close semantics must remain separate');
assert(manager.includes('entry.teamHistoryMissing') && manager.includes('缺失 / 需重新关联') && manager.includes('teamHistoryTaskCount'), 'unresolved individual history photos must render a diagnostic card without calling the normal loader');
assert(manager.includes('readableLegacyMediaError') && manager.includes('重试预览') && manager.includes("title={error}>{error"), 'preview failures must expose their actionable error text and retry in the visible UI');
assert(!people.includes('if (!nextUrl) {\n          const original = await legacyApi.getMediaOriginal'), 'return and candidate thumbnails must never fall back to original media');
assert(manager.includes('advancedStatusLoading') && manager.includes('advancedStatusError') && manager.includes('onRetryAdvancedStatus'), 'advanced status must distinguish checking, failure/retry, and resolved states');
assert(entry.includes('initialWorkspace: managerWorkspaceSeed') && entry.includes('hydrateLegacyWorkspace'), 'legacy-main must pass its hydrated project snapshot into every mounted manager');
for (const [source, label] of [[manager, 'detection'], [people, 'workflow']]) assert(source.includes('initialWorkspace') && source.includes('createWorkspaceSeedGate') && source.includes('isSeeded(seedScopeKey)'), `${label} manager must consume the root snapshot before considering its own project RPC`);
assert(manager.indexOf('isSeeded(seedScopeKey)') < manager.indexOf('void loadIdentities()') && people.indexOf('isSeeded(seedScopeKey)') < people.indexOf('void load(true)'), 'manager mount effects must test the initial seed before issuing project reads');
assert(!manager.includes('window.electronAPI') && !people.includes('window.electronAPI'), 'legacy UI may only use the component adapter');
for (const method of ['team.project.get.v1', 'team.patch.get.v1', 'team.media.authorize.v1', 'team.identity.confirm-group.v1', 'team.workflow.generate.v1', 'team.workflow.return-confirm.v1', 'team.workflow.reconcile-drain.v1', 'team.patch.merge.v1', 'team.progress.create.v1', 'team.settings.update.v1']) assert(adapter.includes(`'${method}'`) || entry.includes(`'${method}'`) || settingsContent.includes(`'${method}'`), `versioned adapter route missing: ${method}`);
assert(people.includes("finally { setBusy(''); }") && people.includes('确认返图失败：${error instanceof Error ? error.message : String(error)}'), 'manual return confirmation must clear its spinner when the RPC rejects');
assert(people.includes("setBusy('workflow-review-discard');\n      try {") && people.includes('放弃返图审核批次失败：${error instanceof Error ? error.message : String(error)}') && people.includes("} finally { setBusy(''); }"), 'discarding a return-review batch must report rejected RPCs and always release workflow busy state');
assert(people.includes('const wasAccepted = Boolean(current.matches.find(item => item.returnId === match.returnId)?.accepted);') && people.includes('const acceptedDelta = wasAccepted ? 0 : 1;') && !people.includes('acceptedCount: (current.acceptedCount || 0) + (result.idempotent ? 0 : 1)'), 'an idempotent confirmation retry must reconcile counters from the previous local match state');
for (const stateCopy of ['返图已确认 · 接力准备中', '接力已就绪', '接力更新失败']) assert(people.includes(stateCopy), `manual confirmation UI must distinguish state: ${stateCopy}`);
assert(!people.includes('确认返图并完成任务') && people.includes('确认返图</button>'), 'the fast confirmation action must not claim relay publication is already complete');
assert(settingsEntry.includes("context.surface !== 'application.settings'") && settingsEntry.includes('<TeamSettingsContent') && !settingsEntry.includes('pf-modal-backdrop') && !settingsEntry.includes('aria-label="关闭设置"'), 'the application settings entry must render the shared content as a non-modal root');
assert(settingsHtml.includes('class="component-settings-root"') && settingsStyle.includes('overflow-x:hidden; overflow-y:auto') && settingsStyle.includes('height:auto; min-height:100%; overflow:visible'), 'the independent settings root must scroll without horizontal overflow in a small WebContentsView');
assert(settingsContent.includes('aria-label="优先使用 GPU"') && settingsContent.includes('aria-label="超大人物裁剪方式"'), 'team settings controls must expose explicit accessible names');
assert(settingsEntry.includes("import './settings-style.css'") && !settingsEntry.includes("import './legacy-style.css'"), 'the official settings surface must use its small Host-contract stylesheet instead of the legacy workspace stylesheet');
assert(settingsEntry.includes('data-settings-contract="host-v1"') && settingsContent.includes('data-settings-visual-contract="official-host-v1"') && settingsContent.includes('data-settings-row'), 'official settings structure must retain the Host visual contract markers');
assert(!settingsContent.includes('<pre') && !settingsContent.includes('JSON.stringify'), 'official settings must never expose raw advanced-runtime payloads');
assert(!style.includes('.notice{') && !style.includes('.notice.error'), 'retired local notification CSS must be removed');
assert(entry.includes("notify(guard.reason, 'warning')") && manager.includes("onNotice(`人物姓名已修改为“${name}”`, 'success')") && people.includes("result.warning ? 'warning' : 'success'") && people.includes("保存姓名失败：${result.error || '未知错误'}`, 'error'") && settingsContent.includes(", 'error');"), 'representative blocked, success, warning, and failure paths must pass explicit notification tones');
assert(settingsContent.includes('window.photoFlowComponent.onActivate') && settingsContent.includes('refreshEnvironment()') && settingsContent.includes('statusGuardRef.current.invalidate()'), 'advanced environment status must refresh on every surface activation and reject stale status responses');
assert(entry.includes('<TeamSettingsContent') && !entry.includes('PairDETR + SAM 2.1'), 'the compatibility dialog must be a thin shell over the shared settings implementation');
assert(adapter.includes("['photoflow-ref', kind") && !adapter.includes('sourcePath: task.') && !adapter.includes('returnedPath:'), 'media compatibility must use opaque IDs instead of exposing or submitting paths');
for (const topic of ['team.patch.detect.progress.v1', 'team.patch.detect-batch.progress.v1', 'team.return.progress.v1', 'team.workflow.progress.v1']) {
  assert(manifest.componentHost.service.events.includes(topic), `manifest event allowlist missing: ${topic}`);
  assert(adapter.includes(`'${topic}'`), `legacy renderer subscription missing V2 event topic: ${topic}`);
  assert(service.includes(`'${topic}'`), `service event mapping missing: ${topic}`);
}
const workflowCssMarker = '/* Weeks stack vertically. Each person gets one compact horizontal task lane. */';
const migratedWorkflowCss = legacyStyle.slice(legacyStyle.indexOf(workflowCssMarker));
for (const rule of ['grid-template-columns: minmax(175px, 205px) minmax(0, 1fr)', 'width: 220px', 'height: 150px', 'overflow-x: auto', '@media (max-width: 900px)', 'var(--pf-surface)']) assert(migratedWorkflowCss.includes(rule), `workflow CSS key rule missing: ${rule}`);
for (const marker of [
  '.workflow-board-view{display:flex;min-width:0;min-height:100%;flex-direction:column',
  'main:has(>div>.workflow-board-view){overflow-x:hidden;overflow-y:auto',
  'height:auto;min-height:100%;max-width:none',
  '.workflow-person-lane{display:grid;min-width:0;grid-template-columns:minmax(175px,205px)minmax(0,1fr)',
  '.workflow-task-strip{display:flex;min-width:0;gap:var(--pf-space-3);overflow-x:auto;overflow-y:hidden',
  '.workflow-task-card{display:grid;width:220px;flex:none;grid-template-columns:74pxminmax(0,1fr)',
  '.workflow-task-thumbnail{width:100%;height:150px;overflow:hidden',
  '@media(max-width:900px)',
]) assert(compactStyle.includes(marker), `sandbox renderer lost pre-component workflow layout rule: ${marker}`);
assert(compactStyle.includes('html,body,#app{width:100%;height:100%;margin:0;overflow:hidden') && compactStyle.includes('.legacy-root.top-10{top:0;}'), 'the isolated #app viewport must fill its WebContentsView and mechanically remove the old app-titlebar offset');
for (const marker of ['.team-stage-nav', '.team-stage-button[aria-current="step"]', '@media(max-width:760px)', 'grid-template-columns:repeat(4,minmax(2.5rem,1fr))', '.team-photo-layout{grid-template-columns:minmax(0,1fr)']) assert(compactStyle.includes(marker), `four-stage narrow layout missing: ${marker}`);
const steps = read('renderer/src/legacy/TeamRetouchSteps.tsx');
for (const stage of ["'detect'", "'assignment'", "'relay'", "'review'"]) assert(steps.includes(stage) || read('renderer/src/interaction-model.ts').includes(stage), `stage navigation missing ${stage}`);
assert(entry.includes("step !== 'detect'") && !entry.includes("step === 'workflow'"), 'legacy-main must be the single four-stage entry without the old split route');

console.log('Team-retouch legacy renderer parity tests passed');
