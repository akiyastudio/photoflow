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
  let recent = [];
  for (const [message, offset] of [['A error', 0], ['B error', 10], ['A error', 20], ['B error', 30]]) {
    const decision = model.recordRendererError(recent, message, now + offset);
    recent = decision.occurrences;
    assert.strictEqual(decision.report, offset < 20, 'interleaved fingerprints are deduplicated independently within the window');
  }

  recent = [];
  for (let index = 0; index < 200; index += 1) {
    const decision = model.recordRendererError(recent, `unique error ${index}`, now + index);
    assert.strictEqual(decision.report, true, 'a new fingerprint must still be reported during a flood');
    recent = decision.occurrences;
    assert(recent.length <= 64, 'the five-second occurrence cache must remain bounded');
  }
  assert.strictEqual(recent[0].fingerprint, model.rendererErrorFingerprint('unique error 136'), 'bounded history must retain the latest fingerprints');
  const expired = model.recordRendererError(recent, 'after expiry', now + 5_200);
  assert.deepStrictEqual(expired.occurrences, [{ fingerprint: model.rendererErrorFingerprint('after expiry'), reportedAt: now + 5_200 }], 'expired fingerprints must be removed before recording a new occurrence');

  const oversizedHistory = Array.from({ length: 10_000 }, (_, index) => ({
    fingerprint: `history-${index}`,
    reportedAt: index < 9_936 ? now : now + index,
  }));
  const bounded = model.recordRendererError(oversizedHistory, 'bounded-new-error', now + 10_000);
  assert(bounded.occurrences.length <= 64, 'an unexpectedly oversized caller history must still produce a bounded result');
  assert(bounded.occurrences.some(item => item.fingerprint === 'history-9999'), 'bounded processing must retain the latest valid historical fingerprint');
  assert.strictEqual(bounded.occurrences.at(-1).fingerprint, model.rendererErrorFingerprint('bounded-new-error'));

  console.log('renderer error notice model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
