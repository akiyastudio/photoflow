(function exposeVersioningV2Model(root) {
  'use strict';

  const TRACKING_LABELS = Object.freeze({
    disabled: '未跟踪',
    pending_compare: '跟踪处理中',
    pending_confirm: '跟踪处理中',
    committing: '跟踪处理中',
    ready: '已跟踪',
    stale: '待刷新',
    needs_repair: '需要修复',
  });

  const PANEL_DEFINITIONS = Object.freeze({
    create: Object.freeze({
      title: '新建进度',
      states: Object.freeze(['ready', 'processing', 'result', 'failure']),
    }),
    import: Object.freeze({
      title: '导入进度',
      states: Object.freeze(['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']),
    }),
    modify: Object.freeze({
      title: '修改进度',
      states: Object.freeze(['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']),
    }),
    confirm: Object.freeze({
      title: '确认跟踪图片',
      states: Object.freeze(['loading', 'waiting_confirmation', 'committing', 'result', 'failure']),
    }),
  });

  function normalizePolicy(relationKind, policy) {
    const requested = policy || {};
    if (relationKind === 'auxiliary') {
      return { trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false };
    }
    const trackingEnabled = Boolean(requested.trackingEnabled);
    return {
      trackingEnabled,
      renameFromParent: trackingEnabled && Boolean(requested.renameFromParent),
      copyMissingFromParent: trackingEnabled && Boolean(requested.copyMissingFromParent),
    };
  }

  function trackingLabel(node) {
    if (node && node.role === 'original') return '原始素材';
    return TRACKING_LABELS[node && node.trackingState] || '未知状态';
  }

  function selectionOutputName(sourceFolderName) {
    const name = String(sourceFolderName || '').trim();
    if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
      throw new Error('来源文件夹名无效');
    }
    return `${name}_选片`;
  }

  function planSelectionOutput({ sourceNodeId, sourceFolderName, existingBinding, targetOccupied }) {
    const outputName = selectionOutputName(sourceFolderName);
    if (existingBinding && existingBinding.sourceNodeId === sourceNodeId) {
      return { action: 'reuse', outputName, overwrite: false };
    }
    if (targetOccupied || existingBinding) {
      return { action: 'conflict', code: 'output_name_conflict', outputName, overwrite: false };
    }
    return { action: 'create', outputName, overwrite: false };
  }

  function propagateStale(nodes, event) {
    return nodes.map((node) => ({ ...node, trackingPolicy: { ...node.trackingPolicy } })).map((node, _index, snapshot) => {
      if (node.id === event.nodeId && event.mediaChanged && node.trackingState === 'ready') {
        return { ...node, trackingState: 'stale' };
      }
      const parentAddedMedia = event.changeKind === 'added' && node.parentNodeId === event.nodeId;
      const participates = node.role === 'progress'
        && node.relationKind === 'main'
        && node.trackingState === 'ready'
        && node.trackingPolicy.trackingEnabled
        && node.trackingPolicy.copyMissingFromParent;
      return parentAddedMedia && participates ? { ...node, trackingState: 'stale' } : node;
    });
  }

  function canCommitConfirmation(items) {
    const blocked = items.filter((item) => item.status === 'pending_confirmation' || item.status === 'missing_reference');
    return { allowed: blocked.length === 0, blockedIds: blocked.map((item) => item.id) };
  }

  function defaultComparisonStatus(matchKind) {
    if (matchKind === 'new_media') return 'pending_confirmation';
    if (matchKind === 'recognized') return 'recognized';
    if (matchKind === 'missing_reference') return 'missing_reference';
    throw new Error('未知比较结果');
  }

  function firstPreviewItemId(items) {
    const list = Array.isArray(items) ? items : [];
    const pending = list.find((item) => item.status === 'pending_confirmation');
    const missing = list.find((item) => item.status === 'missing_reference');
    return (pending || missing || list[0] || {}).id;
  }

  function nextPendingItemId(items, currentId) {
    const list = Array.isArray(items) ? items : [];
    const start = Math.max(0, list.findIndex((item) => item.id === currentId));
    for (let offset = 1; offset <= list.length; offset += 1) {
      const item = list[(start + offset) % list.length];
      if (item && (item.status === 'pending_confirmation' || item.status === 'missing_reference')) return item.id;
    }
    return undefined;
  }

  function adjacentPreviewItemId(items, currentId, direction) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return undefined;
    const current = list.findIndex((item) => item.id === currentId);
    const index = current < 0 ? 0 : (current + direction + list.length) % list.length;
    return list[index].id;
  }

  function previousPreviewItemId(items, currentId) {
    return adjacentPreviewItemId(items, currentId, -1);
  }

  function nextPreviewItemId(items, currentId) {
    return adjacentPreviewItemId(items, currentId, 1);
  }

  function comparisonPairForItem(item) {
    if (!item) return { reference: null, current: null, referenceMissing: true };
    return {
      reference: item.referencePreviewUrl || null,
      current: item.sourcePreviewUrl || null,
      referenceMissing: item.status === 'missing_reference' || !item.referencePreviewUrl,
    };
  }

  function applyTrackingDecision(items, itemId, status, referenceName) {
    if (status !== 'accepted' && status !== 'rejected') throw new Error('invalid tracking decision');
    return (Array.isArray(items) ? items : []).map((item) => {
      if (item.id !== itemId) return item;
      const decision = { ...item, status };
      if (referenceName !== undefined) decision.referenceName = referenceName;
      return decision;
    });
  }

  function startTask(taskId, sessionId) {
    if (!taskId || !sessionId) throw new Error('compare/refresh 必须同时返回 taskId 和 sessionId');
    return { taskId, sessionId };
  }

  function visibleMainParent(nodes, nodeId) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let cursor = byId.get(nodeId);
    const visited = new Set();
    while (cursor && cursor.parentNodeId) {
      if (visited.has(cursor.id)) throw new Error('版本关系形成循环');
      visited.add(cursor.id);
      const parent = byId.get(cursor.parentNodeId);
      if (!parent) return null;
      if (!parent.deletedAt && parent.relationKind !== 'auxiliary' && parent.role !== 'selection') return parent.id;
      cursor = parent;
    }
    return null;
  }

  const api = Object.freeze({
    TRACKING_LABELS,
    PANEL_DEFINITIONS,
    normalizePolicy,
    trackingLabel,
    selectionOutputName,
    planSelectionOutput,
    propagateStale,
    canCommitConfirmation,
    firstPreviewItemId,
    nextPendingItemId,
    previousPreviewItemId,
    nextPreviewItemId,
    comparisonPairForItem,
    applyTrackingDecision,
    defaultComparisonStatus,
    startTask,
    visibleMainParent,
  });

  root.VersioningV2Model = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
