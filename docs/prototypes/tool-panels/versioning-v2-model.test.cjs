'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./versioning-v2-model.cjs');

test('四个面板声明可切换的完整状态集合', () => {
  assert.deepEqual(Object.keys(model.PANEL_DEFINITIONS), ['create', 'import', 'modify', 'confirm']);
  assert.deepEqual(model.PANEL_DEFINITIONS.import.states, ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']);
  assert.deepEqual(model.PANEL_DEFINITIONS.confirm.states, ['loading', 'waiting_confirmation', 'committing', 'result', 'failure']);
});

test('auxiliary 强制关闭全部跟踪策略，main 保留合法选择', () => {
  const requested = { trackingEnabled: true, renameFromParent: true, copyMissingFromParent: true };
  assert.deepEqual(model.normalizePolicy('auxiliary', requested), {
    trackingEnabled: false,
    renameFromParent: false,
    copyMissingFromParent: false,
  });
  assert.deepEqual(model.normalizePolicy('main', requested), requested);
  assert.deepEqual(model.normalizePolicy('main', { trackingEnabled: false, renameFromParent: true, copyMissingFromParent: true }), {
    trackingEnabled: false,
    renameFromParent: false,
    copyMissingFromParent: false,
  });
});

test('内部状态映射不把 needs_repair 冒充已跟踪，original 优先显示角色', () => {
  assert.equal(model.trackingLabel({ role: 'progress', trackingState: 'ready' }), '已跟踪');
  assert.equal(model.trackingLabel({ role: 'progress', trackingState: 'needs_repair' }), '需要修复');
  assert.equal(model.trackingLabel({ role: 'original', trackingState: 'ready' }), '原始素材');
});

test('选片输出严格命名、同源复用且不覆盖，异源占用报冲突', () => {
  assert.deepEqual(model.planSelectionOutput({ sourceNodeId: 'source-a', sourceFolderName: 'RAW' }), {
    action: 'create', outputName: 'RAW_选片', overwrite: false,
  });
  assert.equal(model.planSelectionOutput({
    sourceNodeId: 'source-a', sourceFolderName: 'RAW', existingBinding: { sourceNodeId: 'source-a' }, targetOccupied: true,
  }).action, 'reuse');
  assert.deepEqual(model.planSelectionOutput({
    sourceNodeId: 'source-b', sourceFolderName: 'RAW', existingBinding: { sourceNodeId: 'source-a' }, targetOccupied: true,
  }), { action: 'conflict', code: 'output_name_conflict', outputName: 'RAW_选片', overwrite: false });
});

test('父版本新增只传播到开启补齐的 main progress，不传播到 auxiliary', () => {
  const policy = { trackingEnabled: true, renameFromParent: false, copyMissingFromParent: true };
  const nodes = [
    { id: 'parent', role: 'progress', relationKind: 'main', parentNodeId: null, trackingState: 'ready', trackingPolicy: policy },
    { id: 'main-child', role: 'progress', relationKind: 'main', parentNodeId: 'parent', trackingState: 'ready', trackingPolicy: policy },
    { id: 'no-copy', role: 'progress', relationKind: 'main', parentNodeId: 'parent', trackingState: 'ready', trackingPolicy: { ...policy, copyMissingFromParent: false } },
    { id: 'selection', role: 'selection', relationKind: 'auxiliary', parentNodeId: 'parent', trackingState: 'ready', trackingPolicy: policy },
  ];
  const changed = model.propagateStale(nodes, { nodeId: 'parent', mediaChanged: true, changeKind: 'added' });
  assert.equal(changed.find((node) => node.id === 'parent').trackingState, 'stale');
  assert.equal(changed.find((node) => node.id === 'main-child').trackingState, 'stale');
  assert.equal(changed.find((node) => node.id === 'no-copy').trackingState, 'ready');
  assert.equal(changed.find((node) => node.id === 'selection').trackingState, 'ready');
});

test('新素材默认待确认，未处理项会阻止提交', () => {
  assert.equal(model.defaultComparisonStatus('new_media'), 'pending_confirmation');
  assert.deepEqual(model.canCommitConfirmation([
    { id: 'recognized', status: 'recognized' },
    { id: 'new', status: 'pending_confirmation' },
    { id: 'missing', status: 'missing_reference' },
  ]), { allowed: false, blockedIds: ['new', 'missing'] });
  assert.equal(model.canCommitConfirmation([
    { id: 'accepted', status: 'accepted' },
    { id: 'rejected', status: 'rejected' },
  ]).allowed, true);
});

test('后台启动协议同时要求 taskId 与 sessionId', () => {
  assert.deepEqual(model.startTask('task-42', 'session-42'), { taskId: 'task-42', sessionId: 'session-42' });
  assert.throws(() => model.startTask('task-42', ''), /taskId 和 sessionId/);
});

test('被删除主节点的后代投影连接到最近仍存在的主祖先', () => {
  const nodes = [
    { id: 'root', role: 'original', relationKind: null, parentNodeId: null, deletedAt: null },
    { id: 'v1', role: 'progress', relationKind: 'main', parentNodeId: 'root', deletedAt: null },
    { id: 'v2', role: 'progress', relationKind: 'main', parentNodeId: 'v1', deletedAt: '2026-08-09T00:00:00Z' },
    { id: 'v3', role: 'progress', relationKind: 'main', parentNodeId: 'v2', deletedAt: null },
  ];
  assert.equal(model.visibleMainParent(nodes, 'v3'), 'v1');
});

test('confirmation preview selection prioritizes unresolved items and navigates deterministically', () => {
  const items = [
    { id: 'done', status: 'recognized' },
    { id: 'missing', status: 'missing_reference' },
    { id: 'pending', status: 'pending_confirmation' },
    { id: 'accepted', status: 'accepted' },
  ];
  assert.equal(model.firstPreviewItemId(items), 'pending');
  assert.equal(model.nextPendingItemId(items, 'pending'), 'missing');
  assert.equal(model.previousPreviewItemId(items, 'done'), 'accepted');
  assert.equal(model.nextPreviewItemId(items, 'accepted'), 'done');
  assert.equal(model.firstPreviewItemId([{ id: 'done', status: 'recognized' }]), 'done');
});

test('comparison pairs expose missing references without inventing image data', () => {
  assert.deepEqual(model.comparisonPairForItem({
    id: 'missing', status: 'missing_reference', sourcePreviewUrl: 'current.svg', referencePreviewUrl: '',
  }), { reference: null, current: 'current.svg', referenceMissing: true });
  assert.deepEqual(model.comparisonPairForItem({
    id: 'known', status: 'recognized', sourcePreviewUrl: 'current.svg', referencePreviewUrl: 'reference.svg',
  }), { reference: 'reference.svg', current: 'current.svg', referenceMissing: false });
});

test('decisions update status and optional relationship name while preserving preview links', () => {
  const items = [{
    id: 'new', status: 'pending_confirmation', sourceName: 'new.raw', referenceName: null,
    sourcePreviewUrl: 'current.svg', referencePreviewUrl: 'reference.svg',
  }];
  const accepted = model.applyTrackingDecision(items, 'new', 'accepted', 'old.raw');
  assert.equal(accepted[0].status, 'accepted');
  assert.equal(accepted[0].referenceName, 'old.raw');
  assert.equal(accepted[0].sourcePreviewUrl, 'current.svg');
  assert.equal(accepted[0].referencePreviewUrl, 'reference.svg');
  assert.equal(items[0].status, 'pending_confirmation');
  assert.equal(model.nextPendingItemId(accepted, 'new'), undefined);
});
