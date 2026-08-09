const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const padding = { top: 10, right: 10, bottom: 10, left: 10 };

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'marquee-selection-model.ts')).href);
  const autoScroll = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'marquee-auto-scroll.ts')).href);

  const reverse = model.normalizeMarqueeRect({ x: 90, y: 80 }, { x: 20, y: 15 });
  assert.deepStrictEqual(reverse, { left: 20, top: 15, right: 90, bottom: 80, width: 70, height: 65 }, 'bottom-right to top-left drags must normalize without direction assumptions');

  const contentPoint = model.viewportPointToContentPoint({ x: 125, y: 90 }, { viewportLeft: 25, viewportTop: 20, scrollLeft: 12, scrollTop: 240, contentLeft: 4, contentTop: 10 });
  assert.deepStrictEqual(contentPoint, { x: 108, y: 300 }, 'viewport coordinates must include scroll offsets and content origin offsets');
  const beforeAutoScroll = model.viewportPointToContentPoint({ x: 125, y: 90 }, { viewportLeft: 25, viewportTop: 20, scrollLeft: 0, scrollTop: 100 });
  const afterAutoScroll = model.viewportPointToContentPoint({ x: 125, y: 90 }, { viewportLeft: 25, viewportTop: 20, scrollLeft: 0, scrollTop: 180 });
  assert.deepStrictEqual(afterAutoScroll, { x: beforeAutoScroll.x, y: beforeAutoScroll.y + 80 }, 'auto-scroll must advance the pointer in content coordinates without moving the drag origin');

  const criticalSurfaceWidth = 324;
  const criticalGrid = model.calculateFileGridGeometry(criticalSurfaceWidth, 100);
  const outerWidthColumns = Math.floor((criticalSurfaceWidth + model.FILE_GRID_GAP) / (100 + model.FILE_GRID_GAP));
  assert.strictEqual(outerWidthColumns, 3, 'the critical outer width can appear to fit three columns');
  assert.strictEqual(criticalGrid.contentWidth, 276, '24px padding on each side must be removed from the surface width');
  assert.strictEqual(criticalGrid.columns, 2, 'the real content box can only fit two columns');
  assert.strictEqual(criticalGrid.padding.left, 24);
  assert.strictEqual(criticalGrid.gap, 12);

  const start = { x: 15, y: 15 };
  const end = { x: 130, y: 130 };
  const selection = model.normalizeMarqueeRect(start, end);
  const threeColumns = { kind: 'grid', columns: 3, rowHeight: 40, columnWidth: 40, gap: 5, padding };
  const twoColumns = { ...threeColumns, columns: 2 };
  assert.deepStrictEqual(model.normalizeMarqueeRect(start, end), selection, 'changing layout parameters must not rewrite the content-space drag origin');
  assert.notDeepStrictEqual(model.gridItemRect(4, threeColumns), model.gridItemRect(4, twoColumns), 'resizing columns must recompute item geometry from the new layout');
  const resizedGrid = model.calculateFileGridGeometry(400, 100);
  assert.strictEqual(resizedGrid.columns, 3);
  const visibleCardIndex = 1;
  assert(model.hitMarqueeIndices(model.gridItemRect(visibleCardIndex, criticalGrid), 8, criticalGrid).includes(visibleCardIndex), 'the visible card must be hit before resize');
  assert(model.hitMarqueeIndices(model.gridItemRect(visibleCardIndex, resizedGrid), 8, resizedGrid).includes(visibleCardIndex), 'the same visible card must be hit after resize geometry is recomputed');

  const virtualIndex = 37;
  const virtualRect = model.gridItemRect(virtualIndex, threeColumns);
  assert(model.hitMarqueeIndices(virtualRect, 80, threeColumns).includes(virtualIndex), 'logical hit testing must include indices that have no rendered DOM node');

  const edgeLeft = model.normalizeMarqueeRect({ x: 0, y: 0 }, { x: 20, y: 20 });
  const edgeRight = model.normalizeMarqueeRect({ x: 20, y: 5 }, { x: 30, y: 15 });
  assert.strictEqual(model.rectanglesIntersect(edgeLeft, edgeRight), true, 'touching rectangle edges must count as an intersection');

  const listLayout = { kind: 'list', rowHeight: 30, columnWidth: 240, gap: 2, padding };
  assert.deepStrictEqual(model.listItemRect(3, listLayout), { left: 10, top: 106, right: 250, bottom: 136, width: 240, height: 30 });
  assert.strictEqual(model.calculateFileGridGeometry(70, 100).columns, 1, 'narrow content must remain a single finite column');
  assert.deepStrictEqual(model.logicalCanvasSize(0, criticalGrid), { width: 48, height: 0 }, 'an empty grid must not create an unbounded canvas');
  assert.deepStrictEqual(model.logicalCanvasSize(7, twoColumns), { width: 105, height: 195 });
  assert.deepStrictEqual(model.logicalCanvasSize(4, listLayout), { width: 260, height: 146 });
  const extendedSelection = model.normalizeMarqueeRect({ x: 20, y: 30 }, { x: 500, y: 700 });
  assert.deepStrictEqual(model.finiteLogicalCanvasSize(1, criticalGrid, { width: 360, height: 240 }, extendedSelection), { width: 500, height: 700 }, 'logical canvas must cover content, viewport, and the current finite marquee');
  assert.deepStrictEqual(model.finiteLogicalCanvasSize(0, listLayout, { width: 320, height: 200 }), { width: 320, height: 200 }, 'empty list mode must cover only its finite viewport');

  const createDomScrollContainer = () => ({
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 200,
    scrollWidth: 200,
    clientHeight: 200,
    clientWidth: 200,
    getBoundingClientRect: () => ({ top: 0, right: 200, bottom: 200, left: 0 }),
  });
  const runDelayedDomGrowthScenario = (axis) => {
    const container = createDomScrollContainer();
    const pointer = axis === 'vertical' ? { clientX: 100, clientY: 199 } : { clientX: 199, clientY: 100 };
    const pendingFrames = [];
    let active = true;
    const frame = () => {
      if (!active) return;
      const result = autoScroll.advanceMarqueeAutoScroll(container, pointer);
      if (result.edgeActive) pendingFrames.push(frame);
    };
    pendingFrames.push(frame);
    pendingFrames.shift()();
    assert.strictEqual(axis === 'vertical' ? container.scrollTop : container.scrollLeft, 0, `${axis} short content cannot scroll before the logical canvas DOM commit`);
    assert.strictEqual(pendingFrames.length, 1, `${axis} edge scrolling must retain a next frame while DOM dimensions are stale`);
    if (axis === 'vertical') container.scrollHeight = 320;
    else container.scrollWidth = 320;
    pendingFrames.shift()();
    assert((axis === 'vertical' ? container.scrollTop : container.scrollLeft) > 0, `${axis} scrolling must resume after delayed DOM growth without another pointer move`);
    active = false;
    pendingFrames.length = 0;
    assert.strictEqual(pendingFrames.length, 0, 'pointer up or cancellation must stop the scheduled loop');
  };
  runDelayedDomGrowthScenario('vertical');
  runDelayedDomGrowthScenario('horizontal');

  const emptyContainer = createDomScrollContainer();
  const emptyBlockedFrame = autoScroll.advanceMarqueeAutoScroll(emptyContainer, { clientX: 100, clientY: 199 });
  assert.deepStrictEqual(emptyBlockedFrame, { edgeActive: true, scrolled: false }, 'an empty DOM surface at its edge must remain retryable while its finite logical canvas grows');
  const centerFrame = autoScroll.advanceMarqueeAutoScroll(emptyContainer, { clientX: 100, clientY: 100 });
  assert.deepStrictEqual(centerFrame, { edgeActive: false, scrolled: false }, 'leaving the edge must stop DOM auto-scroll retries');

  assert.deepStrictEqual(model.mergeMarqueeSelection(['a', 'b'], ['b', 'c'], true), ['a', 'c'], 'Ctrl marquee selection must toggle hits against the initial selection');
  assert.deepStrictEqual(model.mergeMarqueeSelection(['a'], ['b', 'b'], false), ['b']);
  console.log('Marquee selection model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
