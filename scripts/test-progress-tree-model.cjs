const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { collectProgressSubtree, inspectProgressRelations } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'progress-tree-model.ts')).href);

  const selfReference = [{ id: 'self', parentProgressId: 'self' }];
  const selfResult = inspectProgressRelations(selfReference);
  assert.strictEqual(selfResult.needsRepair, true);
  assert.deepStrictEqual(new Set(selfResult.cycleNodeIds), new Set(['self']));

  const twoNodeCycle = [
    { id: 'a', parentProgressId: 'b' },
    { id: 'b', parentProgressId: 'a' },
  ];
  const twoResult = collectProgressSubtree(twoNodeCycle, 'a');
  assert.strictEqual(twoResult.needsRepair, true);
  assert.deepStrictEqual(new Set(twoResult.cycleNodeIds), new Set(['a', 'b']));

  const threeNodeCycle = [
    { id: 'a', parentProgressId: 'c' },
    { id: 'b', parentProgressId: 'a' },
    { id: 'c', parentProgressId: 'b' },
  ];
  const threeResult = inspectProgressRelations(threeNodeCycle);
  assert.strictEqual(threeResult.needsRepair, true);
  assert.deepStrictEqual(new Set(threeResult.cycleNodeIds), new Set(['a', 'b', 'c']));

  const depth = 50_000;
  const deepTree = Array.from({ length: depth }, (_, index) => ({
    id: `node-${index}`,
    parentProgressId: index ? `node-${index - 1}` : undefined,
  }));
  const deepResult = collectProgressSubtree(deepTree, 'node-0');
  assert.strictEqual(deepResult.needsRepair, false);
  assert.strictEqual(deepResult.visitedIds.size, depth, 'iterative traversal must handle a legal tree deeper than the JavaScript call stack');

  console.log('progress tree cycle-safety tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
