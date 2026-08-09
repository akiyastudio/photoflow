const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'versioning', 'versioning-v2-model.ts')).href);
  assert.deepStrictEqual(Object.keys(model.VERSION_PANEL_DEFINITIONS), ['create', 'import', 'modify', 'confirm']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.create.states], ['ready', 'processing', 'result', 'failure']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.import.states], ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.modify.states], ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.confirm.states], ['loading', 'waiting_confirmation', 'committing', 'result', 'failure']);
  assert.deepStrictEqual(model.normalizeTrackingPolicy('auxiliary', { trackingEnabled: true, renameFromParent: true, copyMissingFromParent: true }), {
    trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false,
  });
  assert.deepStrictEqual(model.normalizeProgressSetupTrackingPolicy('main', { trackingEnabled: true, renameSources: true, copyMissingFromParent: true }), {
    trackingEnabled: true, renameFromParent: true, copyMissingFromParent: true,
  }, 'the legacy progress setup field must persist the rename-from-parent policy');
  assert.deepStrictEqual(model.normalizeProgressSetupTrackingPolicy('auxiliary', { trackingEnabled: true, renameSources: true, copyMissingFromParent: true }), {
    trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false,
  });
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'original', trackingState: 'ready' }), '原始素材');
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'progress', trackingState: 'stale' }), '待刷新');
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'progress', trackingState: 'needs_repair' }), '版本关系需要修复');
  assert.deepStrictEqual(model.planProgressRootMove('客户/一组/RAW'), { sourceRelativePath: '客户/一组/RAW', targetRelativePath: 'RAW', requiresMove: true });
  assert.strictEqual(model.selectionOutputName('客户/一组/RAW'), 'RAW_选片');

  const base = { projectId: 'p', mediaKind: 'image', versionKey: '', displayName: '', folderPath: '', missingSince: undefined, trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled', lastTrackedAt: undefined, trackingSnapshot: {}, folderSignature: '', tombstone: {}, repairBatchId: undefined, pendingOperationCount: 0, createdAt: 0, updatedAt: 0 };
  const nodes = [
    { ...base, id: 'root', nodeRole: 'original', relationKind: 'main', folderMissing: false },
    { ...base, id: 'hidden', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'root', folderMissing: true },
    { ...base, id: 'main', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'hidden', folderMissing: false },
    { ...base, id: 'selection', nodeRole: 'selection', relationKind: 'auxiliary', parentProgressId: 'main', folderMissing: false },
  ];
  const graph = model.projectVisibleVersionGraph(nodes);
  assert.deepStrictEqual(graph.folders.map(node => node.id), ['root', 'main', 'selection']);
  assert.deepStrictEqual(graph.edges, [
    { parentId: 'root', childId: 'main', relationKind: 'main' },
    { parentId: 'main', childId: 'selection', relationKind: 'auxiliary' },
  ]);
  const cyclic = model.projectVisibleVersionGraph([
    { ...nodes[0], id: 'a', parentProgressId: 'b' },
    { ...nodes[0], id: 'b', parentProgressId: 'a' },
  ]);
  assert.deepStrictEqual(new Set(cyclic.cycleNodeIds), new Set(['a', 'b']));
  assert.strictEqual(model.progressTrackingAction({ ...nodes[2], relationKind: 'auxiliary', nodeRole: 'selection' }), null);
  console.log('versioning V2 production model tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
