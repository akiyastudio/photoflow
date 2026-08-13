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
  state = model.applyTrackingItemDecision(state, 'missing', 'accepted', 'relocated.jpg');
  assert.strictEqual(state.items.find(item => item.id === 'missing').referenceName, 'relocated.jpg', 'relocation updates the persisted relationship name');
  assert.strictEqual(model.canCommitTrackingSession(state.items), true, 'commit opens only after every item is resolved');
  assert.strictEqual(model.canCommitTrackingSession(items), false, 'unresolved items gate commit');

  const missingPaths = model.resolveTrackingComparisonPaths(items[2], 'C:\\parent', 'C:\\current');
  assert.strictEqual(missingPaths.referenceMissing, true, 'new media renders the missing-reference placeholder');
  assert.strictEqual(missingPaths.referencePath, '', 'placeholder does not invent a reference path');
  assert.strictEqual(missingPaths.sourcePath, 'C:\\current\\new.jpg');

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
  assert(panelSource.includes("commitUnavailable ? '有待确认图片' : '提交结果'"), 'the unavailable commit action explains that images still need confirmation');

  console.log('version tracking confirmation UI model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
