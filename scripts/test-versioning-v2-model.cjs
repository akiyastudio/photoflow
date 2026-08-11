const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'versioning', 'versioning-v2-model.ts')).href);
  assert.deepStrictEqual(Object.keys(model.VERSION_PANEL_DEFINITIONS), ['create', 'create-next', 'import', 'modify', 'confirm']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.create.states], ['ready', 'processing', 'result', 'failure']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS['create-next'].states], ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']);
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
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'selection', relationKind: 'auxiliary', trackingState: 'disabled' }), '选片辅助节点');
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'progress', trackingState: 'stale' }), '待刷新');
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'progress', trackingState: 'needs_repair' }), '版本关系需要修复');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'artifact', artifactKind: 'preview', versionKey: 'legacy-preview-mov' }), '预览');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'workflow', artifactKind: 'team_workspace', versionKey: 'team-workspace' }), '协作');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'progress', versionKey: '2' }), 'V2');
  assert.deepStrictEqual(model.planProgressRootMove('客户/一组/RAW'), { sourceRelativePath: '客户/一组/RAW', targetRelativePath: 'RAW', requiresMove: true });
  assert.strictEqual(model.selectionOutputName('客户/一组/RAW'), '图片选片');
  assert.strictEqual(model.selectionOutputName('客户/一组/MOV'), '视频选片');

  const base = { projectId: 'p', mediaKind: 'image', versionKey: '', displayName: '', folderPath: '', missingSince: undefined, trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled', lastTrackedAt: undefined, trackingSnapshot: {}, folderSignature: '', tombstone: {}, repairBatchId: undefined, pendingOperationCount: 0, createdAt: 0, updatedAt: 0 };
  assert.strictEqual(model.progressTrackingAction({ ...base, id: 'branch', nodeRole: 'progress', relationKind: 'main', versionKey: '1_1', trackingEnabled: true, trackingState: 'ready' }), 'refresh', 'V1_1 version branches must retain the full tracking workflow');
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
  assert.match(model.progressRelationChangeError(nodes.map(node => node.id === 'main' ? { ...node, trackingEnabled: true } : node), 'main', null), /关闭跟踪/);
  assert.strictEqual(model.progressRelationChangeError(nodes, 'main', null), '');
  assert.match(model.progressRelationChangeError(nodes, 'selection', null), /不能断开为根节点/);
  assert.strictEqual(model.progressRelationChangeError(nodes, 'main', 'selection'), '', 'selection to progress is a valid workflow_input');

  const semanticNodes = [
    { ...base, id: 'raw-semantic', nodeRole: 'original', relationKind: undefined, folderMissing: false, displayName: '不是靠名称识别', versionKey: 'zzz' },
    { ...base, id: 'camera-jpg', nodeRole: 'artifact', artifactKind: 'companion', relationKind: undefined, folderMissing: false, displayName: 'RAW', versionKey: '1' },
    { ...base, id: 'generated-jpg', nodeRole: 'artifact', artifactKind: 'preview', relationKind: undefined, folderMissing: false, displayName: '图片后期_999', versionKey: '999' },
    { ...base, id: 'image-selection', nodeRole: 'selection', relationKind: 'auxiliary', parentProgressId: 'raw-semantic', folderMissing: false, displayName: '随意名称', versionKey: '0' },
    { ...base, id: 'team-workflow', nodeRole: 'workflow', artifactKind: 'team_workspace', relationKind: undefined, folderMissing: false, displayName: '也不靠名称', versionKey: '0' },
  ];
  const semanticEdges = [
    { id: 'companion', projectId: 'p', sourceProgressId: 'raw-semantic', targetProgressId: 'camera-jpg', edgeKind: 'media_companion', createdAt: 0, updatedAt: 0 },
    { id: 'preview', projectId: 'p', sourceProgressId: 'raw-semantic', targetProgressId: 'generated-jpg', edgeKind: 'derived_preview', createdAt: 0, updatedAt: 0 },
    { id: 'invalid-jpg-team', projectId: 'p', sourceProgressId: 'camera-jpg', targetProgressId: 'team-workflow', edgeKind: 'workflow_input', createdAt: 0, updatedAt: 0 },
  ];
  const semanticGraph = model.projectVisibleVersionGraph(semanticNodes, semanticEdges);
  assert.deepStrictEqual(
    semanticGraph.edges.filter(edge => edge.id).map(edge => ({ id: edge.id, parentId: edge.parentId, childId: edge.childId, relationKind: edge.relationKind })),
    [
      { id: 'preview', parentId: 'raw-semantic', childId: 'generated-jpg', relationKind: 'derived_preview' },
      { id: 'companion', parentId: 'raw-semantic', childId: 'camera-jpg', relationKind: 'media_companion' },
    ],
    'the executable graph projection must preserve supplemental edges instead of relying on a source-string assertion',
  );
  assert.deepStrictEqual(model.selectableVersionParents(semanticNodes, { mediaKind: 'image', relationKind: 'main' }).map(node => node.id), ['raw-semantic'], 'artifacts, selections, and workflows are never structural parents');
  assert.strictEqual(model.defaultMainParentId(semanticNodes, semanticEdges, 'image'), 'raw-semantic', 'RAW/JPG companion semantics select the graph source without reading names or version keys');
  const videoNodes = [
    { ...base, id: 'mov-semantic', mediaKind: 'video', nodeRole: 'original', relationKind: undefined, folderMissing: false, displayName: '不是 MOV', versionKey: 'preview' },
    { ...base, id: 'mov-preview', mediaKind: 'video', nodeRole: 'artifact', artifactKind: 'preview', relationKind: undefined, folderMissing: false, displayName: 'MOV', versionKey: '0' },
  ];
  const videoEdges = [{ id: 'video-preview-edge', projectId: 'p', sourceProgressId: 'mov-semantic', targetProgressId: 'mov-preview', edgeKind: 'derived_preview', createdAt: 0, updatedAt: 0 }];
  assert.strictEqual(model.defaultMainParentId(videoNodes, videoEdges, 'video'), 'mov-semantic', 'MOV/preview semantics select MOV through roles and graph edges');
  assert.deepStrictEqual(model.defaultWorkflowInputIds(semanticNodes, semanticEdges, 'raw-semantic'), ['image-selection'], 'the first post-production progress defaults to the source selection');
  const v1 = { ...base, id: 'v1', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'raw-semantic', folderMissing: false, displayName: '无版本名称', versionKey: 'not-a-number' };
  assert.strictEqual(model.defaultMainParentId([...semanticNodes, v1], semanticEdges, 'image'), 'v1', 'the unique main progress leaf becomes the next default parent');
  assert.deepStrictEqual(model.defaultWorkflowInputIds([...semanticNodes, v1], semanticEdges, 'v1'), [], 'selection is not propagated to later versions');
  assert.deepStrictEqual(model.selectableVersionParents([...semanticNodes, v1], { mediaKind: 'image', relationKind: 'main' }).map(node => node.id), ['raw-semantic', 'v1'], 'ordinary original and progress nodes remain manually selectable');
  assert.strictEqual(model.defaultMainParentId([
    semanticNodes[0],
    { ...semanticNodes[0], id: 'other-original' },
  ], [], 'image'), '', 'ambiguous original sources require an explicit user choice');
  const persistedWorkflowEdge = { id: 'workflow', projectId: 'p', sourceProgressId: 'team-workflow', targetProgressId: 'v1', edgeKind: 'workflow_input', createdAt: 0, updatedAt: 0 };
  assert.deepStrictEqual(model.defaultWorkflowInputIds([...semanticNodes, v1], [persistedWorkflowEdge], 'raw-semantic', 'v1'), ['team-workflow'], 'modify mode reflects persisted workflow_input edges');
  assert.deepStrictEqual(
    model.workflowInputIdsForRelationChange([...semanticNodes, v1], [persistedWorkflowEdge], 'v1', 'raw-semantic'),
    ['team-workflow', 'image-selection'],
    'manually connecting RAW to V1 atomically preserves workflow inputs and adds the matching selection input',
  );
  assert.deepStrictEqual(
    model.workflowInputIdsForRelationChange([...semanticNodes, v1], [persistedWorkflowEdge], 'v1', 'v1'),
    ['team-workflow'],
    'connecting to another progress removes selection inputs that belong to the original source',
  );
  console.log('versioning V2 production model tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
