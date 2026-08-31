const assert = require('node:assert/strict');
const { createExplicitStartController } = require('../ui/explicit-start-model.js');

const context = { surface: 'project.contextAction', projectId: 'project-1', scopeRelativePath: 'video', selectedRelativePaths: ['video/a.mp4'] };
const starts = []; const runs = []; const completedRuns = []; const views = [];
let releaseStart;
const controller = createExplicitStartController({
  startProject: payload => { starts.push(payload); return new Promise(resolve => { releaseStart = resolve; }); },
  runOperation: payload => { runs.push(payload); return Promise.resolve({ id: payload.operationId, state: 'completed' }); },
  onRunComplete: result => completedRuns.push(result),
  onChange: view => views.push(view),
});

(async () => {
  controller.setContext(context);
  assert.equal(starts.length, 0, 'initial context must not start recognition');
  assert.deepEqual(controller.view(), { count: 1, disabled: false, label: '开始识别' });

  controller.setContext({ ...context, selectedRelativePaths: ['video/b.mp4', 'video/folder'] });
  assert.equal(starts.length, 0, 'context changes must not start recognition');
  assert.equal(controller.view().label, '开始识别');

  const first = controller.start();
  assert.equal(starts.length, 1, 'one click creates one project task');
  assert.deepEqual(starts[0].relativePaths, ['video/b.mp4', 'video/folder']);
  assert.deepEqual(controller.view(), { count: 2, disabled: true, label: '正在开始…' });
  controller.setContext({ ...context, selectedRelativePaths: ['video/b.mp4', 'video/folder'] });
  assert.deepEqual(controller.view(), { count: 2, disabled: true, label: '正在开始…' }, 'duplicate context delivery preserves the pending gate');
  assert.deepEqual(await controller.start(), { accepted: false, reason: 'pending' }, 'concurrent duplicate clicks are suppressed');
  assert.equal(starts.length, 1);
  releaseStart({ operationId: 'operation-1' });
  assert.equal((await first).accepted, true);
  assert.deepEqual(runs, [{ operationId: 'operation-1' }], 'the accepted task is run exactly once');
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(completedRuns, [{ id: 'operation-1', state: 'completed' }], 'the terminal run result is delivered to the page immediately');
  assert.deepEqual(controller.view(), { count: 2, disabled: false, label: '重新识别当前选择' });

  const second = controller.start();
  assert.equal(starts.length, 2, 'success permits a later explicit rerun');
  releaseStart({ operationId: 'operation-2' });
  await second;
  assert.deepEqual(runs, [{ operationId: 'operation-1' }, { operationId: 'operation-2' }]);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(completedRuns.at(-1), { id: 'operation-2', state: 'completed' });

  controller.setContext({ ...context, selectedRelativePaths: [] });
  assert.deepEqual(controller.view(), { count: 0, disabled: true, label: '请在文件页选择视频或文件夹' });
  assert.deepEqual(await controller.start(), { accepted: false, reason: 'empty-selection' }, 'empty selection is rejected');
  assert.equal(starts.length, 2);
  assert(views.some(view => view.label === '正在开始…'));
  console.log('video-transcription explicit start controller tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
