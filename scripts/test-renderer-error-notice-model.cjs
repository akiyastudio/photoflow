const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'app', 'renderer-error-notice-model.ts')).href);
  const reactError = 'Maximum update depth exceeded. This can happen when a component calls setState.\n    at FileMetadataPane (http://localhost:5173/src/App.tsx:10:2)';
  assert.strictEqual(model.rendererErrorNoticeSummary(reactError), '界面状态更新发生循环，详细信息已写入日志。');
  const ordinary = model.rendererErrorNoticeSummary('读取失败 %s http://localhost:5173/src/App.tsx:2:1\n    at Component');
  assert(!ordinary.includes('%s'));
  assert(!ordinary.includes('localhost'));
  assert(!ordinary.includes('\n'));
  assert(model.rendererErrorNoticeSummary('x'.repeat(400)).length <= 180);

  const now = 10_000;
  assert(model.shouldReportRendererError(null, 'same error', now));
  const previous = { fingerprint: model.rendererErrorFingerprint('same error'), reportedAt: now };
  assert(!model.shouldReportRendererError(previous, 'same error', now + 100), 'identical errors must be suppressed briefly');
  assert(model.shouldReportRendererError(previous, 'different error', now + 100));
  assert(model.shouldReportRendererError(previous, 'same error', now + 5_000), 'the same error may be reported again after the window');

  console.log('renderer error notice model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
