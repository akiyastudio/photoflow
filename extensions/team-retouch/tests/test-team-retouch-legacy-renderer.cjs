const assert = require('assert');
// Plugin-owned regression test.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manager = read('renderer/src/legacy/TeamRetouchManager.tsx');
const people = read('renderer/src/legacy/PersonIdentityManager.tsx');
const identityPickerPanel = read('renderer/src/legacy/IdentityPickerPanel.tsx');
const workflowHeader = read('renderer/src/legacy/TeamWorkflowHeader.tsx');
const comparison = read('renderer/src/legacy/ImageComparisonView.tsx');
const adapter = read('renderer/src/legacy/legacy-api.ts');
const revisionModel = read('renderer/src/legacy/legacy-revision-model.ts');
const taskFolderModel = read('renderer/src/legacy/legacy-task-folder-model.ts');
const entry = read('renderer/src/legacy-main.tsx');
const settingsEntry = read('renderer/src/settings-main.tsx');
const settingsContent = read('renderer/src/team-settings-content.tsx');
const settingsHtml = read('renderer/settings.html');
const html = read('renderer/index.html');
const legacyStyle = read('renderer/src/legacy-style.css');
const settingsStyle = read('renderer/src/settings-style.css');
const hostUi = read('renderer/src/host-api-ui.css');
const style = read('renderer/src/legacy-style.css');
const compactStyle = style.replace(/\s+/g, '');
const manifest = JSON.parse(read('component.template.json'));
const service = read('service.cjs');
for (const [source, file] of [[entry, 'legacy-main.tsx'], [settingsEntry, 'settings-main.tsx'], [manager, 'TeamRetouchManager.tsx'], [people, 'PersonIdentityManager.tsx'], [settingsContent, 'team-settings-content.tsx']]) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = node => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['notify', 'onNotice'].includes(node.expression.text)) assert(node.arguments.length >= 2, `${file} notification calls must pass an explicit tone`); ts.forEachChild(node, visit); };
  visit(parsed);
}

assert(html.includes('/src/legacy-main.tsx'), 'packaged renderer must enter the source-faithful legacy migration');
assert(!fs.existsSync(path.join(root, 'renderer/src/main.tsx')) && !fs.existsSync(path.join(root, 'renderer/src/style.css')), 'retired renderer entry must not preserve a second sticky task-notification surface');
assert(!manager.includes('legacy-photo-card') && !people.includes('legacy-photo-card'), 'legacy page must not be replaced by a hand-built lookalike');
for (const marker of ['FullscreenImageViewer', 'ImageZoomButton', 'PatchPreview', 'IdentitySubjectThumb', 'InteractiveCropEditor', 'IdentityPicker', 'onPointerMove']) assert(manager.includes(marker), `detection/identity migration lost ${marker}`);
for (const copy of ['自动识别结果默认采用', '自动标记人物', '调整范围', '全窗口浏览图片']) assert(manager.includes(copy), `legacy detection interaction copy missing: ${copy}`);
assert(people.includes('自动分组已默认采用') && people.includes('识别错误可修改') && !people.includes('自动候选 · {Math.round(subject.assignment.confidence * 100)}% · 请人工确认'), 'automatic identity candidates must be presented as accepted-by-default and user-editable');
assert(identityPickerPanel.includes('aria-label="搜索人物姓名"') && identityPickerPanel.includes('filteredIdentities') && identityPickerPanel.includes('xl:grid-cols-5'), 'shared identity picker must support name search and a compact five-column desktop grid');
assert(manager.includes('data-identity-candidate-grid') && manager.includes('grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'), 'identity candidate grid must use the same compact five-column desktop layout');
assert(identityPickerPanel.includes('h-[94vh] max-h-[94vh] w-full max-w-7xl'), 'shared identity picker must keep its maximum-height shell while search results change');
assert(!manager.includes('正在读取整个项目') && manager.includes('正在读取团片历史中的人物与工作图'), 'history manager loading copy must reflect registered-history scope');
for (const marker of ['WorkflowReturnReviewDialog', 'moveWorkflowIdentityPointerDrag', 'workflowIdentityWeeks', 'generateWorkflow', 'mergeCompletedPhotos', 'TeamOutputProgressPicker']) assert(people.includes(marker), `workflow migration lost ${marker}`);
assert(people.includes('data-merge-progress') && people.includes('mergeProgress.completed') && people.includes('mergeProgress.succeeded') && people.includes('mergeProgress.failed'), 'batch merge must expose live processed/succeeded/failed progress');
assert(!people.includes('Math.min(3, mergeablePhotos.length)') && !people.includes('Math.min(3, mergedPhotos.length)') && people.includes('await worker();'), 'merge batches must submit sequentially so every photo uses the latest project revision');
for (const copy of ['data-merge-review-surface', '张照片已就绪，可以合并', '全部 ${photoRows.length} 张照片检查通过', '查看全部照片', '高级质量检查', '旧数据未记录']) assert(people.includes(copy), `merge review redesign missing: ${copy}`);
assert(people.includes('const reoutputPhoto = async') && people.match(/rebuildToken: crypto\.randomUUID\(\)/g)?.length >= 3 && people.includes('重新输出') && people.includes('onReoutput={photo => void reoutputPhoto(photo)}'), 'normal merge, single reoutput, and batch reoutput must each use a fresh publication identity');
assert(people.includes("const mergeActionLabel: '开始合并' | '继续合并' | '全部重新合并'") && people.includes('data-merge-actions') && people.includes('onMergeAction={() => void (allPhotosMergedOnce ? remergeAllPhotos() : mergeCompletedPhotos())}'), 'review must expose one bottom action that starts, continues, or freshly remerges every photo according to merge state');
assert(!people.includes('审核通过并合并') && !people.includes('全部重新输出') && !people.includes('onReoutputAll'), 'superseded top merge and batch reoutput actions must be removed');
assert(people.indexOf('<TeamOutputProgressPicker controller={outputProgress}') < people.indexOf('{mergeActionBusy ? <Loader2'), 'the merge destination must render immediately above the bottom merge action');
assert(style.includes('[data-merge-audit] { display: none !important; }'), 'the superseded diagnostic dashboard must be hidden after the decision-focused merge review is mounted');
for (const copy of ['任务分配', '接力进度', '审核输出', '个批次', '人跨周']) assert(people.includes(copy), `four-stage workflow copy missing: ${copy}`);
for (const copy of ['设置人物工作周顺序', '每周独占一行', '批量导入返图', '合并前阻断清单']) assert(people.includes(copy), `four-stage interaction missing: ${copy}`);
assert(!people.includes('同周开始') && !people.includes('下一周开始') && people.includes('data-workflow-week-row') && people.includes('data-workflow-week-label'), 'assignment must show one labeled row per week without relationship chips');
assert(people.includes("activeStep === 'assignment' ? assignmentSequence") && people.includes('const assignmentSequence = <section data-assignment-sequence') && people.includes('本页不展示具体修图裁片') && !people.includes('高级排期 ·'), 'assignment stage must be a sequence-only editor without the legacy week/task-image panel');
assert(compactStyle.includes('[data-workflow-week-row]{display:grid') && compactStyle.includes('grid-template-columns:5remminmax(0,1fr)') && compactStyle.includes('[data-workflow-week-people]{display:flex'), 'assignment sequence must render one horizontally arranged row per labeled week');
assert(people.includes('compactGroups.flatMap(group => group.slice(1))'), 'dragging between week rows must persist the implied same-week grouping');
assert(people.includes('const currentStageSummaries = workflowStageSummaries(workspace, activeStep)') && people.includes('currentStageSummaries.find(stage => stage.id === nextStep)') && people.includes('stageSummaries={currentStageSummaries}'), 'next buttons and future task tabs must use the live workspace completion state');
assert(people.includes('modificationAssessment.label'), 'return evidence label must come from the tested progressive-enhancement model');
assert(people.includes('data-relay-chains') && people.includes('relayChainForItems') && people.includes('当前持有人'), 'relay stage must render semantic handoff chains');
assert(people.includes('relayChainsOpen') && people.includes('aria-expanded={relayChainsOpen}') && people.includes('setRelayChainsOpen(current => !current)') && people.includes('接力链（{relayChains.length}）'), 'relay chains must use a collapsed-by-default accessible disclosure panel');
assert(people.includes('data-return-evidence') && people.includes('returnModificationAssessment') && people.includes('returnMatchAssessment'), 'return review must separate matching and modification evidence');
assert(people.includes('nextPendingReturnId') && people.includes('confirmAndAdvance') && people.includes('ignoreAndAdvance') && people.includes('onConfirm={confirmWorkflowReturn}') && people.includes('onIgnore={ignoreWorkflowReturn}'), 'successful confirm and ignore actions must advance to the next pending return');
assert(people.includes('这个任务已经完成，不能再修改人物归属') && people.includes('interactive={!item.assignment?.completed}') && !people.includes('prepareCompletedSubjectForIdentityChange'), 'completed workflow images must not enter visual identity reassignment');
assert(people.includes('SubjectFullscreenViewer') && people.includes('全窗口浏览图片') && people.includes('<Maximize2 size={14}/>'), 'every workflow subject thumbnail must expose an independent fullscreen viewer action');
assert(service.includes("kind: 'openOutputDirectory'") && !service.includes("kind: 'revealOutput'"), 'task folders must open in a new in-app project tab rather than the system file manager');
assert(manager.includes('<IdentityPickerPanel') && people.includes('<IdentityPickerPanel') && identityPickerPanel.includes('aria-label="确认人物身份"') && identityPickerPanel.includes('grid-cols-[280px_minmax(0,1fr)]'), 'marking and workflow reassignment must render the same shared identity picker shell');
assert(identityPickerPanel.includes('data-identity-picker-grid') && identityPickerPanel.includes('grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'), 'both identity workflows must share one compact searchable five-column identity grid');
assert(people.includes('identityPickerBusy') && identityPickerPanel.includes('busyLabel = \'正在保存人物归属…\'') && identityPickerPanel.includes('absolute inset-0 z-10 cursor-pointer'), 'shared identity selection must keep the dialog open with a busy footer and fullscreen-safe card overlay behavior');
assert(manager.includes('data-manual-crop-warning') && manager.includes('需要人工调整裁剪范围') && manager.includes('当前为整幅工作图') && manager.includes('旧数据缺少 generation 元数据'), 'generation crop decisions must be prominent and degrade explicitly for old data');
for (const hierarchy of ['workflow-board-view', 'workflow-person-lane', 'workflow-person-summary', 'workflow-task-strip', 'workflow-task-card', 'workflow-task-thumbnail']) assert(people.includes(hierarchy), `workflow DOM hierarchy missing: ${hierarchy}`);
assert(people.includes('workspaceLoadError') && people.includes('重新读取团片历史') && people.includes('workspaceLoadSequenceRef'), 'workflow history load must terminate on error, expose retry, and reject stale results');
for (const mode of ['side-by-side', 'split', 'overlay', 'blink', 'difference']) assert(comparison.includes(`'${mode}'`), `return comparison lost ${mode} mode`);
assert(!manager.includes('aria-label="团片协作设置"') && !people.includes('aria-label="团片协作设置"') && entry.includes('TeamSettingsDialog'), 'task pages must omit the redundant settings action while retaining the compatibility settings surface');
assert(!manager.includes('onClick={onOpenSettings}') && !manager.includes('if (!next.length) onClose();') && manager.includes('当前项目没有团片协作图片'), 'task-page settings removal and empty-list semantics must remain separate');
assert(!manager.includes('继续设置任务') && manager.includes('下一步：{WORKFLOW_STAGES.find') && people.includes('下一步：{nextStage?.label}') && manager.includes('team-next-step flex justify-center') && people.includes('team-next-step mt-6 flex justify-center'), 'forward navigation must be centered and name its destination task');
assert(!manager.includes('team-next-step flex justify-center border-t') && !people.includes('team-next-step mt-6 flex justify-center border-t'), 'next-step areas must not render horizontal separator lines');
assert(manager.includes('<TeamWorkflowHeader') && people.includes('<TeamWorkflowHeader') && workflowHeader.includes('<TeamRetouchBrand/>') && entry.includes('<TeamRetouchBrand/>'), 'all workflow pages must share the canonical compact plugin header and brand');
assert(manager.includes('entry.teamHistoryMissing') && manager.includes('缺失 / 需重新关联') && manager.includes('teamHistoryTaskCount'), 'unresolved individual history photos must render a diagnostic card without calling the normal loader');
assert(manager.includes('readableLegacyMediaError') && manager.includes('重试预览') && manager.includes("title={error}>{error"), 'preview failures must expose their actionable error text and retry in the visible UI');
assert(!people.includes('if (!nextUrl) {\n          const original = await legacyApi.getMediaOriginal'), 'return and candidate thumbnails must never fall back to original media');
for (const retiredCache of ['identityThumbnailRequests', 'identityThumbnailUrls', 'returnImageUrls', 'identityThumbnailListeners']) assert(!people.includes(retiredCache), `renderer must not retain project-unscoped media cache: ${retiredCache}`);
assert(adapter.includes('mediaAuthorizationGeneration') && adapter.includes('项目已切换，旧媒体授权已失效'), 'late media authorization responses must be generation-scoped and ignored after project switches');
assert(manager.includes('advancedStatusLoading') && manager.includes('advancedStatusError') && manager.includes('onRetryAdvancedStatus'), 'advanced status must distinguish checking, failure/retry, and resolved states');
assert(manager.includes("advancedPresentation.state === 'ready'") && manager.includes('{advancedPresentation.text}</span>'), 'available advanced detection must be shown as text immediately before the detection action');
assert(!entry.includes('fixed left-1/2 top-20') && entry.includes("dedupeKey: 'team-retouch:history-migration'") && entry.includes("dedupeKey: 'team-retouch:history-load'"), 'history warnings and errors must update the host toast stack instead of rendering fixed banners');
assert(entry.includes('historyToastTransition') && entry.includes('historyLoadInFlight') && entry.includes("recoveredMessage: '团片历史已恢复'") && entry.includes("recoveredMessage: '团片历史迁移已恢复'"), 'settled history recovery must replace persistent host toasts with same-key transient success notices');
assert(!manager.includes('team-banner flex') && !manager.includes('style={{ width: `${overallProgress}%` }}') && manager.includes('历史恢复需重试') && manager.includes('重新检查高级能力'), 'detection page status belongs in the title bar and keeps recovery actions');
assert(!people.includes('border-b border-blue-100 bg-blue-50 px-5 py-3') && !people.includes('aria-label="批量导入返图进度"') && people.includes('停止生成') && people.includes('data-workflow-return-progress'), 'workflow and return progress belong in the title bar while stop and progress semantics remain available');
assert(manager.includes("presentation: 'silent', outcome: 'failed'") && manager.includes("batchTaskVisibleRef.current ? 'visible' : 'none'") && people.includes("workflowReturnVisibleTaskIdsRef.current.has(operationId) ? 'visible' : 'none'") && people.includes("workflowGenerationVisibleTaskIdsRef.current.has(requestedOperationId) ? 'visible' : 'none'"), 'renderer operations must derive terminal feedback ownership from observed visible-task progress while preserving silent and non-task paths');
assert(entry.includes('initialWorkspace: managerWorkspaceSeed') && entry.includes('hydrateLegacyWorkspace'), 'legacy-main must pass its hydrated project snapshot into every mounted manager');
for (const [source, label] of [[manager, 'detection'], [people, 'workflow']]) assert(source.includes('initialWorkspace') && source.includes('createWorkspaceSeedGate') && source.includes('isSeeded(seedScopeKey)'), `${label} manager must consume the root snapshot before considering its own project RPC`);
assert(manager.indexOf('isSeeded(seedScopeKey)') < manager.indexOf('void loadIdentities()') && people.indexOf('isSeeded(seedScopeKey)') < people.indexOf('void load(true)'), 'manager mount effects must test the initial seed before issuing project reads');
assert(!manager.includes('window.electronAPI') && !people.includes('window.electronAPI'), 'legacy UI may only use the component adapter');
for (const method of ['team.project.get.v1', 'team.patch.get.v1', 'team.media.authorize.v1', 'team.identity.confirm-group.v1', 'team.workflow.generate.v1', 'team.workflow.return-confirm.v1', 'team.workflow.reconcile-drain.v1', 'team.patch.merge.v1', 'team.progress.create.v1', 'team.settings.update.v1']) assert(adapter.includes(`'${method}'`) || entry.includes(`'${method}'`) || settingsContent.includes(`'${method}'`), `versioned adapter route missing: ${method}`);
assert(entry.includes("teamProjectRpc<Json>('team.project.migrate-step.v1')") && entry.includes("teamProjectRpc<Json>('team.project.register.v1'") && !entry.includes("rpc<Json>('team.project.migrate-step.v1')"), 'shell project mutations must share the workflow revision coordinator');
assert(adapter.includes('retryOnceAfterRevisionConflict') && revisionModel.includes('mutationTails') && revisionModel.includes('revision > current'), 'return confirmation must recover once from stale revisions while queued responses remain monotonic');
assert(people.includes('prepareAndOpenWorkflowTaskFolder') && people.includes("onNotice('任务文件夹正在重建，请稍候…', 'info')") && taskFolderModel.includes('recoveredCount'), 'opening an available task group must drain reconstruction work and retry the open automatically');
assert(people.includes('const drainTaskChains = async') && people.includes('index += 50') && (people.match(/drainTaskChains\(\[item\.task\.id\]\)/g) || []).length >= 3 && people.includes("['接力工作图恢复']") && people.includes("relayRecovering ? '接力工作图正在恢复'"), 'upload, undo, and completion changes must rebuild their own relay chain in bounded batches and show an accurate transient state');
assert(people.includes("finally { setBusy(''); }") && people.includes('确认返图失败：${error instanceof Error ? error.message : String(error)}'), 'manual return confirmation must clear its spinner when the RPC rejects');
assert(/setBusy\('workflow-review-discard'\);\r?\n\s*try\s*\{[\s\S]*?await legacyApi\.discardTeamWorkflowReturnReview\([\s\S]*?catch\s*\(error\)\s*\{[\s\S]*?放弃返图审核批次失败：\$\{error instanceof Error \? error\.message : String\(error\)\}[\s\S]*?finally\s*\{\s*setBusy\(''\);\s*\}/.test(people), 'discarding a return-review batch must structurally catch rejected RPCs, notify the error, and release workflow busy state in finally');
assert(people.includes('const wasAccepted = Boolean(current.matches.find(item => item.returnId === match.returnId)?.accepted);') && people.includes('const acceptedDelta = wasAccepted ? 0 : 1;') && !people.includes('acceptedCount: (current.acceptedCount || 0) + (result.idempotent ? 0 : 1)'), 'an idempotent confirmation retry must reconcile counters from the previous local match state');
for (const stateCopy of ['返图已确认 · 接力准备中', '接力已就绪', '接力更新失败']) assert(people.includes(stateCopy), `manual confirmation UI must distinguish state: ${stateCopy}`);
assert(!people.includes('确认返图并完成任务') && people.includes('确认返图</button>'), 'the fast confirmation action must not claim relay publication is already complete');
assert(settingsEntry.includes("context.surface !== 'application.settings'") && settingsEntry.includes('<TeamSettingsContent') && settingsEntry.includes('team.settings.get.v1') && settingsEntry.includes('team.settings.update.v1') && !settingsEntry.includes('pf-modal-backdrop') && !settingsEntry.includes('aria-label="关闭设置"'), 'the application settings entry renders ordinary preferences and advanced lifecycle controls in one plugin page');
assert(settingsHtml.includes('class="component-settings-root"') && settingsStyle.includes('height:100%; min-width:0; min-height:0') && settingsStyle.includes('overflow:hidden') && hostUi.includes('overflow-y: auto'), 'the independent settings root must constrain the WebContentsView while the shared settings page owns vertical scrolling');
assert(settingsContent.includes('aria-label="优先使用 GPU"') && settingsContent.includes('aria-label="超大人物裁剪方式"'), 'team settings controls must expose explicit accessible names');
assert(settingsEntry.includes("import './settings-style.css'") && !settingsEntry.includes("import './legacy-style.css'"), 'the official settings surface must use its small Host-contract stylesheet instead of the legacy workspace stylesheet');
assert(settingsEntry.includes('data-settings-contract="host-v1"') && settingsContent.includes('data-settings-visual-contract="official-host-v1"') && settingsContent.includes('data-settings-row'), 'official settings structure must retain the Host visual contract markers');
assert(!settingsContent.includes('<pre') && !settingsContent.includes('JSON.stringify'), 'official settings must never expose raw advanced-runtime payloads');
assert(!style.includes('.notice{') && !style.includes('.notice.error'), 'retired local notification CSS must be removed');
assert(entry.includes("notify(guard.reason, 'warning')") && manager.includes("onNotice(`人物姓名已修改为“${name}”`, 'success')") && people.includes("onNotice('返图已上传，下一位接力已就绪', 'success')") && people.includes("接力工作图仍在恢复${reconciliation.error") && people.includes("保存姓名失败：${result.error || '未知错误'}`, 'error'") && settingsContent.includes(", 'error');"), 'representative blocked, success, warning, and failure paths must pass explicit notification tones');
assert(settingsContent.includes('window.photoFlowComponent.onActivate') && settingsContent.includes('refreshEnvironment()') && settingsContent.includes('statusGuardRef.current.invalidate()'), 'advanced environment status must refresh on every surface activation and reject stale status responses');
assert(entry.includes('<TeamSettingsContent') && !entry.includes('PairDETR + SAM 2.1'), 'the compatibility dialog must be a thin shell over the shared settings implementation');
assert(adapter.includes("['photoflow-ref', kind") && !adapter.includes('sourcePath: task.') && !adapter.includes('returnedPath:'), 'media compatibility must use opaque IDs instead of exposing or submitting paths');
for (const topic of ['team.patch.detect.progress.v1', 'team.patch.detect-batch.progress.v1', 'team.return.progress.v1', 'team.workflow.progress.v1']) {
  assert(manifest.componentHost.service.events.includes(topic), `manifest event allowlist missing: ${topic}`);
  assert(adapter.includes(`'${topic}'`), `legacy renderer subscription missing plugin event topic: ${topic}`);
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
for (const marker of ['.team-stage-nav', '.team-stage-button[data-selected="true"][data-tone="progress"]', '.team-stage-nav::-webkit-scrollbar', '@media(max-width:760px)', '.team-photo-layout{grid-template-columns:minmax(0,1fr)']) assert(compactStyle.includes(marker), `four-stage tab layout missing: ${marker}`);
const steps = read('renderer/src/legacy/TeamRetouchSteps.tsx');
for (const stage of ["'detect'", "'assignment'", "'relay'", "'review'"]) assert(steps.includes(stage) || read('renderer/src/interaction-model.ts').includes(stage), `stage navigation missing ${stage}`);
assert(steps.includes('disabled={disabled}') && steps.includes('aria-disabled={locked || undefined}') && steps.includes("locked ? onBlocked?.(summary?.blockedReason || '') : onChange(step.id)") && steps.includes('data-selected={selected || undefined}') && steps.includes('data-tone={tone}') && !steps.includes('stepIndex > progressIndex'), 'window selection, workflow progress, and guarded stage explanations must be independent states');
assert(compactStyle.includes('grid-template-columns:repeat(4,minmax(0,1fr))') && steps.includes('grid-cols-4'), 'desktop task tabs must use four explicit equal-width columns');
assert(steps.includes('justify-start') && steps.includes('px-4') && !steps.includes("'✓'"), 'task-tab content must use identical left padding and completed tabs must not render checkmarks');
assert(style.includes('.team-stage-button[data-tone="complete"]') && style.includes('.team-stage-button[data-tone="progress"]') && style.includes('.team-stage-button[data-selected="true"][data-tone="other"]'), 'completed, current-progress, other, and selected-window visuals must remain independent');
assert(entry.includes("step !== 'detect'") && !entry.includes("step === 'workflow'"), 'legacy-main must be the single four-stage entry without the old split route');
assert(entry.includes('latestWorkflowStage') && entry.includes('latestStageProjectRef') && entry.includes('setStep(latestWorkflowStage(workspaceSnapshot))') && entry.includes("latestStageProjectRef.current = ''; setStep('detect')"), 'opening a project must resume its latest workflow stage once without overriding later manual navigation');

console.log('Team-retouch legacy renderer parity tests passed');
