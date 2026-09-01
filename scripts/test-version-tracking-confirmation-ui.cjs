const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'versioning', 'tracking-confirmation-model.ts')).href);
  const session = id => ({ id, progressId: `progress-${id}`, parentProgressId: `parent-${id}`, mode: 'refresh', status: 'pending_confirm', renameFromParent: false, copyMissingFromParent: false, error: '', total: 3, unresolvedCount: 2 });
  const items = [
    { id: 'known', kind: 'recognized', sourceName: 'known.jpg', referenceName: 'known.jpg', targetName: 'known.jpg', status: 'recognized' },
    { id: 'missing', kind: 'missing', sourceName: 'missing-edit.jpg', referenceName: 'missing.jpg', targetName: 'missing-edit.jpg', status: 'missing_reference' },
    { id: 'pending', kind: 'new', sourceName: 'new.jpg', targetName: 'new.jpg', status: 'pending_confirmation' },
  ];
  assert.deepStrictEqual(model.groupTrackingConfirmationItems(items).map(group => [group.category, group.items.map(item => item.id)]), [
    ['recognized', ['known']], ['accepted', []], ['pending', ['pending']], ['missing', ['missing']],
  ], 'confirmation results are grouped into the four V2 categories');

  let state = { sessionId: 'a', items: [], minimized: false };
  state = model.mergeTrackingSessionPage(state, { session: session('a'), items: items.slice(0, 2), nextCursor: 2 });
  state = model.mergeTrackingSessionPage(state, { session: session('a'), items: items.slice(2), nextCursor: null });
  assert.deepStrictEqual(state.items.map(item => item.id), ['known', 'missing', 'pending'], 'pagination pages merge without duplicates');
  assert.strictEqual(state.nextCursor, undefined, 'a Python null cursor terminates pagination instead of reloading the first page forever');
  assert.strictEqual(state.selectedItemId, 'pending', 'default selection waits for all pages and prioritizes pending confirmation');

  state = { ...state, selectedItemId: 'pending' };
  assert.strictEqual(state.selectedItemId, 'pending', 'row click selection is client state');
  state = model.applyTrackingItemDecision(state, 'pending', 'accepted');
  assert.strictEqual(state.selectedItemId, 'missing', 'decision advances to the next unresolved item');
  state = model.applyTrackingItemDecision(state, 'missing', 'rejected');
  assert.strictEqual(state.items.find(item => item.id === 'missing').status, 'rejected', 'a missing current-media row is resolved only as an acknowledged deletion');
  assert.strictEqual(model.canCommitTrackingSession(state.items), true, 'commit opens only after every item is resolved');
  assert.strictEqual(model.canCommitTrackingSession(items), false, 'unresolved items gate commit');
  assert.strictEqual(model.firstUnresolvedTrackingItemId(items), 'missing', 'the pending action selects the first unresolved row in list order');

  const missingPaths = model.resolveTrackingComparisonPaths(items[2], 'C:\\parent', 'C:\\current');
  assert.strictEqual(missingPaths.referenceMissing, true, 'new media renders the missing-reference placeholder');
  assert.strictEqual(missingPaths.referencePath, '', 'placeholder does not invent a reference path');
  assert.strictEqual(missingPaths.sourcePath, 'C:\\current\\new.jpg');

  const legalBasenamePaths = model.resolveTrackingComparisonPaths({ ...items[0], referenceName: '修图 成片 01.jpg', sourceName: '当前 成片 01.jpg' }, 'C:\\parent', 'C:\\current');
  assert.deepStrictEqual(legalBasenamePaths, {
    referencePath: 'C:\\parent\\修图 成片 01.jpg',
    sourcePath: 'C:\\current\\当前 成片 01.jpg',
    referenceMissing: false,
  }, 'common Chinese and spaced basenames remain valid preview paths');
  for (const unsafeName of ['../escape.jpg', '..\\escape.jpg', '/absolute.jpg', 'C:\\absolute.jpg', 'C:drive-relative.jpg', 'nested/file.jpg', 'nested\\file.jpg', `nul\0name.jpg`, 'line\nfeed.jpg', String.fromCharCode(0x7f) + 'control.jpg']) {
    const unsafeReference = model.resolveTrackingComparisonPaths({ ...items[0], referenceName: unsafeName }, 'C:\\parent', 'C:\\current');
    assert.strictEqual(unsafeReference.referencePath, '', `unsafe reference basename must fail closed: ${JSON.stringify(unsafeName)}`);
    assert.strictEqual(unsafeReference.referenceMissing, true, `unsafe reference basename must render unavailable: ${JSON.stringify(unsafeName)}`);
    const unsafeSource = model.resolveTrackingComparisonPaths({ ...items[0], sourceName: unsafeName }, 'C:\\parent', 'C:\\current');
    assert.strictEqual(unsafeSource.sourcePath, '', `unsafe source basename must not create a preview path: ${JSON.stringify(unsafeName)}`);
  }

  const minimized = model.setTrackingPanelMinimized(state, true);
  const resumed = model.setTrackingPanelMinimized(minimized, false);
  assert.strictEqual(resumed.sessionId, state.sessionId, 'minimize and resume retain the same session');
  assert.strictEqual(resumed.items.length, state.items.length);

  const gate = model.createPreviewRequestGate();
  const staleRequest = gate.begin();
  const currentRequest = gate.begin();
  assert.strictEqual(gate.isCurrent(staleRequest), false, 'a stale image request cannot update the next selection');
  assert.strictEqual(gate.isCurrent(currentRequest), true);

  const pageA = model.mergeTrackingSessionPage({ sessionId: 'a', items: [], minimized: false }, { session: session('a'), items: [items[0]] });
  const pageB = model.mergeTrackingSessionPage({ sessionId: 'b', items: [], minimized: false }, { session: session('b'), items: [items[2]] });
  const isolated = model.mergeTrackingSessionPage(pageA, { session: session('b'), items: [items[2]] });
  assert.deepStrictEqual(isolated.items.map(item => item.id), ['known'], 'pages from two workspaces stay isolated by session');
  assert.deepStrictEqual(pageB.items.map(item => item.id), ['pending']);

  const panelSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'versioning', 'TrackingConfirmationPanel.tsx'), 'utf8');
  const workspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const appStyles = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'index.css'), 'utf8');
  assert(!panelSource.includes('缩小到后台') && !panelSource.includes('onMinimize'), 'tracking confirmation no longer exposes a redundant minimize action');
  assert(!workspaceSource.includes('onMinimize={() => setTrackingConfirmationSessionId'), 'workspace does not pass the removed tracking confirmation minimize callback');
  assert(appStyles.includes('html.dark .tracking-confirmation-dialog') && appStyles.includes('html.dark .tracking-confirmation-row.is-selected'), 'tracking confirmation has dedicated dark-theme surfaces and selection colors');
  assert(appStyles.includes('html.dark .bg-white\\/95'), '95% translucent white surfaces are mapped to a dark background');
  assert(panelSource.includes('标记不关联') && panelSource.includes("hasReferenceCandidate ? '不是同一张' : '标记不关联'"), 'items without a previous-version candidate use the explicit unlinked action');
  assert(panelSource.includes('不是同一张') && panelSource.includes('是同一张'), 'items with a reference candidate keep image-relationship wording');
  assert(panelSource.includes('onClick={revealPending}') && panelSource.includes('data-tracking-item-id={item.id}'), 'the pending action reveals and scrolls to the first unresolved image');
  assert(panelSource.includes('limit: TRACKING_PAGE_SIZE') && !panelSource.includes('do {'), 'the confirmation panel must fetch one bounded page instead of retaining the entire session in the renderer');
  assert(panelSource.includes('view.session?.unresolvedCount') && panelSource.includes('setPageCursor(view.nextCursor)'), 'pagination must use the session-wide unresolved count and expose navigation to later pending pages');
  assert(panelSource.includes("selectedItem?.kind === 'missing'") && panelSource.includes('!missingCurrentItem && hasReferenceCandidate'), 'missing current media must not expose relocation or acceptance controls');
  assert(panelSource.includes('actionGenerationRef') && workspaceSource.includes('key={`${workspacePath}:${trackingConfirmationSessionId}`}'), 'session switches must isolate pagination, optimistic decisions, and late async completions');
  assert(panelSource.includes('const viewMatchesSession = view.sessionId === sessionId')
    && panelSource.includes('const sessionActionsAvailable = viewMatchesSession && view.session?.id === sessionId')
    && panelSource.includes('if (!sessionActionsAvailable || !selectedItem || actionInFlightRef.current) return;')
    && panelSource.includes('if (!sessionActionsAvailable || actionInFlightRef.current) return;'), 'decide and release must fail closed while rendered view identity differs from the loaded session prop');
  assert(panelSource.includes('const commitUnavailable = !sessionActionsAvailable') && panelSource.includes('useLayoutEffect(() => {'), 'session mismatch must disable commit UI and reset identity before paint');
  const commitSource = panelSource.slice(panelSource.indexOf('const commit = () =>'), panelSource.indexOf('const release = async'));
  assert(commitSource.includes('window.electronAPI.commitProgressTracking'), 'the confirmation panel must submit through the tracked commit IPC');
  assert(!panelSource.includes('已转入后台提交') && !panelSource.includes('提交跟踪结果失败') && !panelSource.includes('跟踪结果已提交。'), 'the BackgroundTask card must be the sole started, failed, and completed notification for detached commit');

  const pagedState = {
    sessionId: 'paged',
    session: { ...session('paged'), total: 50000, unresolvedCount: 1200 },
    items: [items[2]],
    minimized: false,
  };
  const decidedPage = model.applyTrackingItemDecision(pagedState, 'pending', 'accepted');
  assert.strictEqual(decidedPage.session.unresolvedCount, 1199, 'resolving one paged item must decrement the global unresolved count instead of replacing it with the current-page count');

  console.log('version tracking confirmation UI model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
