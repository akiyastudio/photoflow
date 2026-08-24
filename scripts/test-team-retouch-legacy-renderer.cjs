const assert = require('assert');
const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manager = read('extensions/team-retouch/renderer/src/legacy/TeamRetouchManager.tsx');
const people = read('extensions/team-retouch/renderer/src/legacy/PersonIdentityManager.tsx');
const comparison = read('extensions/team-retouch/renderer/src/legacy/ImageComparisonView.tsx');
const adapter = read('extensions/team-retouch/renderer/src/legacy/legacy-api.ts');
const entry = read('extensions/team-retouch/renderer/src/legacy-main.tsx');
const html = read('extensions/team-retouch/renderer/index.html');
const legacyStyle = read('extensions/team-retouch/renderer/src/legacy-style.css');
const canonicalPerson = childProcess.execFileSync('git', ['show', '7517789:src/components/PersonIdentityManager.tsx'], { cwd: root, encoding: 'utf8' });
const canonicalCss = childProcess.execFileSync('git', ['show', '7517789:src/index.css'], { cwd: root, encoding: 'utf8' });
const normalizedHash = value => crypto.createHash('sha256').update(value.replace(/\s+/g, ' ').trim()).digest('hex');
const between = (value, start, end) => { const from = value.indexOf(start); const to = value.indexOf(end, from); assert(from >= 0 && to > from, `unable to extract parity block: ${start}`); return value.slice(from, to); };
const style = read('extensions/team-retouch/renderer/src/legacy-style.css');
const compactStyle = style.replace(/\s+/g, '');

assert(html.includes('/src/legacy-main.tsx'), 'packaged renderer must enter the source-faithful legacy migration');
assert(!manager.includes('legacy-photo-card') && !people.includes('legacy-photo-card'), 'legacy page must not be replaced by a hand-built lookalike');
for (const marker of ['FullscreenImageViewer', 'ImageZoomButton', 'PatchPreview', 'IdentitySubjectThumb', 'InteractiveCropEditor', 'IdentityPicker', 'onPointerMove']) assert(manager.includes(marker), `detection/identity migration lost ${marker}`);
for (const copy of ['点击人物框或人物行确认身份，可应用到整组。', '重新自动标记人物', '调整范围', '全窗口浏览图片']) assert(manager.includes(copy), `legacy detection interaction copy missing: ${copy}`);
assert(!manager.includes('正在读取整个项目') && manager.includes('正在读取团片历史中的人物与工作图'), 'history manager loading copy must reflect registered-history scope');
for (const marker of ['WorkflowReturnReviewDialog', 'moveWorkflowIdentityPointerDrag', 'toggleSameWeekIdentity', 'generateWorkflow', 'mergeCompletedPhotos', 'TeamOutputProgressPicker']) assert(people.includes(marker), `workflow migration lost ${marker}`);
const canonicalWorkflowJsx = between(canonicalPerson, "{tab === 'workflow' && !loading", '{loading ?');
const migratedWorkflowJsx = between(people, "{tab === 'workflow' && !loading", '{loading ?');
assert.equal(normalizedHash(migratedWorkflowJsx), normalizedHash(canonicalWorkflowJsx), 'workflow overview JSX body must remain text-equivalent to the last mounted pre-component source');
for (const copy of ['流程概览', '个批次', '人跨周']) assert(migratedWorkflowJsx.includes(copy), `workflow parity copy missing: ${copy}`);
for (const copy of ['优先队列', '拖拽开工顺序', '导入并匹配返图', '合成已完成照片']) assert(people.includes(copy), `workflow parity copy missing: ${copy}`);
for (const hierarchy of ['workflow-board-view', 'workflow-person-lane', 'workflow-person-summary', 'workflow-task-strip', 'workflow-task-card', 'workflow-task-thumbnail']) assert(people.includes(hierarchy), `workflow DOM hierarchy missing: ${hierarchy}`);
assert(people.includes('workspaceLoadError') && people.includes('重新读取团片历史') && people.includes('workspaceLoadSequenceRef'), 'workflow history load must terminate on error, expose retry, and reject stale results');
for (const mode of ['side-by-side', 'split', 'overlay', 'blink', 'difference']) assert(comparison.includes(`'${mode}'`), `return comparison lost ${mode} mode`);
assert(manager.includes('aria-label="团片协作设置"') && people.includes('aria-label="团片协作设置"') && entry.includes('TeamSettingsDialog'), 'historic close location must open in-component settings');
assert(manager.includes('onClick={onOpenSettings}') && !manager.includes('if (!next.length) onClose();') && manager.includes('当前项目没有团片协作图片'), 'settings entry and empty-list close semantics must remain separate');
assert(manager.includes('entry.teamHistoryMissing') && manager.includes('缺失 / 需重新关联') && manager.includes('teamHistoryTaskCount'), 'unresolved individual history photos must render a diagnostic card without calling the normal loader');
assert(manager.includes('readableLegacyMediaError') && manager.includes('重试预览') && manager.includes("title={error}>{error"), 'preview failures must expose their actionable error text and retry in the visible UI');
assert(manager.includes('advancedStatusLoading') && manager.includes('advancedStatusError') && manager.includes('onRetryAdvancedStatus'), 'advanced status must distinguish checking, failure/retry, and resolved states');
assert(!manager.includes('window.electronAPI') && !people.includes('window.electronAPI'), 'legacy UI may only use the component adapter');
for (const method of ['team.project.get.v1', 'team.patch.get.v1', 'team.media.authorize.v1', 'team.identity.confirm-group.v1', 'team.workflow.generate.v1', 'team.workflow.return-confirm.v1', 'team.patch.merge.v1', 'project.progress.create.v1', 'component.settings.update.v1']) assert(adapter.includes(`'${method}'`) || entry.includes(`'${method}'`), `versioned adapter route missing: ${method}`);
assert(adapter.includes("['photoflow-ref', kind") && !adapter.includes('sourcePath: task.') && !adapter.includes('returnedPath:'), 'media compatibility must use opaque IDs instead of exposing or submitting paths');
const workflowCssMarker = '/* Weeks stack vertically. Each person gets one compact horizontal task lane. */';
const canonicalWorkflowCss = between(canonicalCss, workflowCssMarker, '.project-navigator-scroll');
const migratedWorkflowCss = legacyStyle.slice(legacyStyle.indexOf(workflowCssMarker));
assert.equal(normalizedHash(migratedWorkflowCss), normalizedHash(canonicalWorkflowCss), 'workflow CSS must be copied verbatim from 7517789 src/index.css');
for (const rule of ['grid-template-columns: minmax(175px, 205px) minmax(0, 1fr)', 'width: 220px', 'height: 150px', 'overflow-x: auto', '@media (max-width: 900px)', 'html.dark .workflow-task-card']) assert(migratedWorkflowCss.includes(rule), `workflow CSS key rule missing: ${rule}`);
for (const marker of [
  '.workflow-board-view{display:flex;min-height:100%;flex-direction:column',
  'main:has(>div>.workflow-board-view){overflow-x:hidden;overflow-y:auto',
  'height:auto;min-height:100%;max-width:none',
  '.workflow-person-lane{display:grid;min-width:0;grid-template-columns:minmax(175px,205px)minmax(0,1fr)',
  '.workflow-task-strip{display:flex;min-width:0;gap:.7rem;overflow-x:auto;overflow-y:hidden',
  '.workflow-task-card{display:grid;width:220px;flex:none;grid-template-columns:74pxminmax(0,1fr)',
  '.workflow-task-thumbnail{width:100%;height:150px;overflow:hidden',
  '@media(max-width:900px)',
]) assert(compactStyle.includes(marker), `sandbox renderer lost pre-component workflow layout rule: ${marker}`);
assert(compactStyle.includes('html,body,#app{height:100%;margin:0}') && compactStyle.includes('.legacy-root.top-10{top:0}'), 'the isolated #app viewport must fill its WebContentsView and mechanically remove the old app-titlebar offset');

console.log('Team-retouch legacy renderer parity tests passed');
