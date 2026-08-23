const assert = require('assert');
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

assert(html.includes('/src/legacy-main.tsx'), 'packaged renderer must enter the source-faithful legacy migration');
assert(!manager.includes('legacy-photo-card') && !people.includes('legacy-photo-card'), 'legacy page must not be replaced by a hand-built lookalike');
for (const marker of ['FullscreenImageViewer', 'ImageZoomButton', 'PatchPreview', 'IdentitySubjectThumb', 'InteractiveCropEditor', 'IdentityPicker', 'onPointerMove']) assert(manager.includes(marker), `detection/identity migration lost ${marker}`);
for (const copy of ['点击人物框或人物行确认身份，可应用到整组。', '重新自动标记人物', '调整范围', '全窗口浏览图片']) assert(manager.includes(copy), `legacy detection interaction copy missing: ${copy}`);
for (const marker of ['WorkflowReturnReviewDialog', 'moveWorkflowIdentityPointerDrag', 'toggleSameWeekIdentity', 'generateWorkflow', 'mergeCompletedPhotos', 'TeamOutputProgressPicker']) assert(people.includes(marker), `workflow migration lost ${marker}`);
for (const mode of ['side-by-side', 'split', 'overlay', 'blink', 'difference']) assert(comparison.includes(`'${mode}'`), `return comparison lost ${mode} mode`);
assert(manager.includes('aria-label="团片协作设置"') && people.includes('aria-label="团片协作设置"') && entry.includes('TeamSettingsDialog'), 'historic close location must open in-component settings');
assert(manager.includes('onClick={onOpenSettings}') && !manager.includes('if (!next.length) onClose();') && manager.includes('当前项目没有团片协作图片'), 'settings entry and empty-list close semantics must remain separate');
assert(!manager.includes('window.electronAPI') && !people.includes('window.electronAPI'), 'legacy UI may only use the component adapter');
for (const method of ['team.project.get.v1', 'team.patch.get.v1', 'team.media.authorize.v1', 'team.identity.confirm-group.v1', 'team.workflow.generate.v1', 'team.workflow.return-confirm.v1', 'team.patch.merge.v1', 'project.progress.create.v1', 'component.settings.update.v1']) assert(adapter.includes(`'${method}'`) || entry.includes(`'${method}'`), `versioned adapter route missing: ${method}`);
assert(adapter.includes("['photoflow-ref', kind") && !adapter.includes('sourcePath: task.') && !adapter.includes('returnedPath:'), 'media compatibility must use opaque IDs instead of exposing or submitting paths');

console.log('Team-retouch legacy renderer parity tests passed');
