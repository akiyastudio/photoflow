const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const modelPath = path.join(__dirname, '..', 'src', 'features', 'versioning', 'version-tree-layout-model.ts');
  const { layoutVersionTree } = await import(pathToFileURL(modelPath).href);
  const node = (id, role = 'progress') => ({ id, nodeRole: role, createdAt: Number(id.replace(/\D/g, '')) || 0 });
  const options = { nodeWidth: 120, nodeHeight: 90, columnGap: 64, rowGap: 28, auxiliaryGap: 36, rootGap: 44 };

  const nodes = [node('root', 'original'), node('selection', 'selection'), node('v1'), node('v2')];
  const edges = [
    { id: 'main-1', parentId: 'root', childId: 'v1', relationKind: 'main' },
    { id: 'main-2', parentId: 'v1', childId: 'v2', relationKind: 'main' },
    { id: 'selection-source', parentId: 'root', childId: 'selection', relationKind: 'auxiliary' },
    { id: 'workflow', parentId: 'selection', childId: 'v2', relationKind: 'workflow_input' },
  ];
  const first = layoutVersionTree({ ...options, nodes, edges });
  assert.equal(first.edges.length, 4, 'DAG layout must retain a second parent edge');
  assert.equal(first.nodes.find(item => item.id === 'root').y, first.nodes.find(item => item.id === 'v1').y, 'main branch should stay horizontal');
  assert.ok(first.nodes.find(item => item.id === 'selection').y > first.nodes.find(item => item.id === 'root').y, 'selection should be below its source');

  const shuffled = layoutVersionTree({ ...options, nodes: [...nodes].reverse(), edges: [edges[2], edges[0], edges[3], edges[1]] });
  assert.deepEqual(
    shuffled.nodes.map(item => [item.id, item.x, item.y]),
    first.nodes.map(item => [item.id, item.x, item.y]),
    'input array order must not affect layout',
  );

  const cyclic = layoutVersionTree({
    ...options,
    nodes: [node('a'), node('b'), node('c')],
    edges: [
      { parentId: 'a', childId: 'b', relationKind: 'main' },
      { parentId: 'b', childId: 'c', relationKind: 'main' },
      { parentId: 'c', childId: 'a', relationKind: 'workflow_input' },
    ],
  });
  assert.equal(cyclic.nodes.length, 3);
  assert.equal(cyclic.edges.length, 2, 'one display edge should be removed to break a dirty cycle');

  const thousandNodes = Array.from({ length: 1000 }, (_, index) => node(`n${index}`, index ? 'progress' : 'original'));
  const thousandEdges = thousandNodes.slice(1).map((item, index) => ({ parentId: `n${index}`, childId: item.id, relationKind: 'main' }));
  const large = layoutVersionTree({ ...options, nodes: thousandNodes, edges: thousandEdges });
  assert.equal(large.nodes.length, 1000);
  assert.equal(large.edges.length, 999);
  assert.ok(large.nodes.every(item => Number.isFinite(item.x) && Number.isFinite(item.y)));

  console.log('version tree DAG layout tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
