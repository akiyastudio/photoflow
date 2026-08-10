import { versionTreeEdgePath } from './version-tree-edge-model.ts';

export type VersionTreeLayoutRelationKind = 'main' | 'auxiliary' | 'media_companion' | 'derived_preview' | 'workflow_input';

export type VersionTreeLayoutNode = {
  id: string;
  nodeRole: 'original' | 'progress' | 'selection' | 'artifact' | 'workflow';
  relationKind?: 'main' | 'auxiliary';
  createdAt: number;
};

export type VersionTreeLayoutEdge = {
  id?: string;
  parentId: string;
  childId: string;
  relationKind: VersionTreeLayoutRelationKind;
};

export type VersionTreeLayoutInput = {
  nodes: readonly VersionTreeLayoutNode[];
  edges: readonly VersionTreeLayoutEdge[];
  nodeWidth: number;
  nodeHeight: number;
  columnGap: number;
  rowGap: number;
  auxiliaryGap?: number;
  rootGap: number;
};

export type PositionedVersionNode = VersionTreeLayoutNode & {
  x: number;
  y: number;
  depth: number;
  subtreeHeight: number;
};

export type PositionedVersionEdge = VersionTreeLayoutEdge & {
  id: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  path: string;
};

export type VersionTreeLayoutResult = {
  nodes: PositionedVersionNode[];
  edges: PositionedVersionEdge[];
  width: number;
  height: number;
};

const roleOrder = { original: 0, workflow: 1, artifact: 2, progress: 3, selection: 4 } as const;
const relationOrder: Record<VersionTreeLayoutRelationKind, number> = { main: 0, auxiliary: 1, workflow_input: 2, media_companion: 3, derived_preview: 4 };
const compareNodes = (left: VersionTreeLayoutNode, right: VersionTreeLayoutNode) =>
  roleOrder[left.nodeRole] - roleOrder[right.nodeRole]
  || relationOrder[left.relationKind || 'main'] - relationOrder[right.relationKind || 'main']
  || left.createdAt - right.createdAt
  || left.id.localeCompare(right.id);
const compareEdges = (left: VersionTreeLayoutEdge, right: VersionTreeLayoutEdge) =>
  relationOrder[left.relationKind] - relationOrder[right.relationKind]
  || left.parentId.localeCompare(right.parentId)
  || left.childId.localeCompare(right.childId)
  || String(left.id || '').localeCompare(String(right.id || ''));

const layoutVersionTreeDag = (input: VersionTreeLayoutInput): VersionTreeLayoutResult => {
  const nodeWidth = Math.max(1, input.nodeWidth);
  const nodeHeight = Math.max(1, input.nodeHeight);
  const columnGap = Math.max(0, input.columnGap);
  const rowGap = Math.max(0, input.rowGap);
  const auxiliaryGap = Math.max(rowGap, input.auxiliaryGap ?? rowGap);
  const rootGap = Math.max(rowGap, input.rootGap);
  const stableNodes = [...new Map([...input.nodes].sort(compareNodes).filter(node => node.id).map(node => [node.id, node])).values()];
  const nodeById = new Map(stableNodes.map(node => [node.id, node]));
  const nodeRank = new Map(stableNodes.map((node, index) => [node.id, index]));
  const adjacency = new Map<string, string[]>();
  const acceptedEdges: VersionTreeLayoutEdge[] = [];
  const edgeKeys = new Set<string>();
  const reaches = (start: string, target: string) => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacency.get(current) || []) pending.push(next);
    }
    return false;
  };
  for (const edge of [...input.edges].sort(compareEdges)) {
    if (edge.parentId === edge.childId || !nodeById.has(edge.parentId) || !nodeById.has(edge.childId)) continue;
    const key = `${edge.parentId}\0${edge.childId}\0${edge.relationKind}`;
    if (edgeKeys.has(key) || reaches(edge.childId, edge.parentId)) continue;
    edgeKeys.add(key);
    acceptedEdges.push(edge);
    const children = adjacency.get(edge.parentId) || [];
    children.push(edge.childId);
    adjacency.set(edge.parentId, children);
  }

  const incoming = new Map<string, VersionTreeLayoutEdge[]>();
  const outgoing = new Map<string, VersionTreeLayoutEdge[]>();
  const indegree = new Map(stableNodes.map(node => [node.id, 0]));
  for (const edge of acceptedEdges) {
    incoming.set(edge.childId, [...(incoming.get(edge.childId) || []), edge]);
    outgoing.set(edge.parentId, [...(outgoing.get(edge.parentId) || []), edge]);
    indegree.set(edge.childId, (indegree.get(edge.childId) || 0) + 1);
  }
  for (const edges of incoming.values()) edges.sort(compareEdges);
  for (const edges of outgoing.values()) edges.sort(compareEdges);
  const compareIds = (left: string, right: string) => (nodeRank.get(left) ?? 0) - (nodeRank.get(right) ?? 0) || left.localeCompare(right);
  const ready = stableNodes.filter(node => indegree.get(node.id) === 0).map(node => node.id).sort(compareIds);
  const orderedIds: string[] = [];
  const depths = new Map<string, number>();
  while (ready.length) {
    const id = ready.shift()!;
    orderedIds.push(id);
    for (const edge of outgoing.get(id) || []) {
      depths.set(edge.childId, Math.max(depths.get(edge.childId) || 0, (depths.get(id) || 0) + 1));
      const next = (indegree.get(edge.childId) || 0) - 1;
      indegree.set(edge.childId, next);
      if (next === 0) { ready.push(edge.childId); ready.sort(compareIds); }
    }
  }
  const orderedSet = new Set(orderedIds);
  for (const node of stableNodes) if (!orderedSet.has(node.id)) orderedIds.push(node.id);

  const positioned = new Map<string, PositionedVersionNode>();
  const occupiedByDepth = new Map<number, number[]>();
  let nextRootY = 0;
  for (const id of orderedIds) {
    const node = nodeById.get(id)!;
    const depth = depths.get(id) || 0;
    const parents = incoming.get(id) || [];
    const anchor = parents.find(edge => edge.relationKind === 'main')
      || parents.find(edge => edge.relationKind === 'auxiliary')
      || parents[0];
    const parent = anchor ? positioned.get(anchor.parentId) : undefined;
    let y = parent
      ? parent.y + (anchor!.relationKind === 'main' || anchor!.relationKind === 'workflow_input' ? 0 : nodeHeight + auxiliaryGap)
      : nextRootY;
    const occupied = occupiedByDepth.get(depth) || [];
    while (occupied.some(candidate => Math.abs(candidate - y) < nodeHeight + rowGap)) y += nodeHeight + rowGap;
    occupied.push(y);
    occupiedByDepth.set(depth, occupied);
    positioned.set(id, { ...node, x: depth * (nodeWidth + columnGap), y, depth, subtreeHeight: nodeHeight });
    if (!parents.length) nextRootY = Math.max(nextRootY, y + nodeHeight + rootGap);
  }
  const nodes = stableNodes.map(node => positioned.get(node.id)!).filter(Boolean);
  const edges = acceptedEdges.map(edge => {
    const parent = positioned.get(edge.parentId)!;
    const child = positioned.get(edge.childId)!;
    const startX = parent.x + nodeWidth;
    const startY = parent.y + nodeHeight / 2;
    const endX = child.x;
    const endY = child.y + nodeHeight / 2;
    return { ...edge, id: edge.id || `${edge.parentId}:${edge.childId}:${edge.relationKind}`, startX, startY, endX, endY, path: versionTreeEdgePath(startX, startY, endX, endY) };
  });
  return {
    nodes,
    edges,
    width: nodes.length ? Math.max(...nodes.map(node => node.x + nodeWidth)) : 0,
    height: nodes.length ? Math.max(...nodes.map(node => node.y + nodeHeight)) : 0,
  };
};

export const layoutVersionTree = (input: VersionTreeLayoutInput): VersionTreeLayoutResult => layoutVersionTreeDag(input);
