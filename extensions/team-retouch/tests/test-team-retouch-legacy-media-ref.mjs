import assert from 'node:assert/strict';
// Plugin-owned regression test.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const calls = [];
let failedTaskId = '';
globalThis.window = {
  photoFlowComponent: {
    contractVersion: 1,
    rpc: async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'team.media.authorize.v1' && payload.taskId === failedTaskId) return { success: false, state: 'MISSING', category: 'history-reference-missing', error: '工作图任务不存在或文件缺失' };
      if (method === 'team.patch.get.v1') return { success: true, baseVersionId: 'registration-base', photo: { id: 'bundle-photo', currentVersionId: 'new-current' }, versions: [{ id: 'registration-base' }, { id: 'new-current', isCurrent: true }], tasks: [{ id: 'bundle-task', baseVersionId: 'registration-base' }] };
      return { success: true, url: `photoflow-media:test/${calls.length}` };
    },
    onEvent: () => () => undefined,
    onActivate: () => () => undefined,
    onDeactivate: () => () => undefined,
    getContext: async () => ({}),
  },
};

const modulePath = pathToFileURL(path.resolve('renderer/src/legacy/legacy-api.ts')).href;
const { legacyApi, legacyMediaRef, parseLegacyMediaRef } = await import(modulePath);
const { legacyPreviewRequests, readableLegacyMediaError, summarizeLegacyPreviewResults } = await import(pathToFileURL(path.resolve('renderer/src/legacy/legacy-media-preview-model.ts')).href);
const cases = [
  { ref: legacyMediaRef('original', '照片:一/1', '版本 % 1'), value: { kind: 'original', photoId: '照片:一/1', baseVersionId: '版本 % 1' } },
  { ref: legacyMediaRef('working', 'photo:2', 'base/2', 'task % 2'), value: { kind: 'working', photoId: 'photo:2', baseVersionId: 'base/2', taskId: 'task % 2' } },
  { ref: legacyMediaRef('returned', 'photo:3', 'base/3', 'task % 3'), value: { kind: 'returned', photoId: 'photo:3', baseVersionId: 'base/3', taskId: 'task % 3' } },
  { ref: legacyMediaRef('review-return', '', '', '', 'session:四', 'return/4'), value: { kind: 'review-return', reviewSessionId: 'session:四', returnId: 'return/4' } },
];
cases.push({ ref: legacyMediaRef('returned', 'photo:person', 'base/person', 'task/person', '', '', '3'), value: { kind: 'returned', photoId: 'photo:person', baseVersionId: 'base/person', taskId: 'task/person', personIndex: 3 } });
for (const item of cases) assert.deepEqual(parseLegacyMediaRef(item.ref), item.value, `${item.value.kind} reference must round-trip`);
for (const invalid of ['', 'photoflow-ref:original:photo:version', 'photoflow-ref:unknown:a:b:c:d:e', 'photoflow-ref:working:p:v:::', 'photoflow-ref:original:%E0%A4%A:v:::', `${cases[0].ref}:extra`]) assert.equal(parseLegacyMediaRef(invalid), undefined, `malformed reference must be rejected: ${invalid}`);

assert.equal((await legacyApi.getMediaOriginal(cases[0].ref)).mediaUrl, 'photoflow-media:test/1');
assert.equal((await legacyApi.getMediaThumbnail(cases[1].ref)).previewUrl, 'photoflow-media:test/2');
assert.equal((await legacyApi.getMediaThumbnail(cases[2].ref)).previewUrl, 'photoflow-media:test/3');
assert.equal((await legacyApi.getMediaOriginal(cases[3].ref)).mediaUrl, 'photoflow-media:test/4');
assert.equal((await legacyApi.openTeamPatch(cases[1].ref)).success, true);
assert.deepEqual(calls, [
  { method: 'team.media.authorize.v1', payload: { ...cases[0].value, variant: 'original' } },
  { method: 'team.media.authorize.v1', payload: { ...cases[1].value, variant: 'preview' } },
  { method: 'team.media.authorize.v1', payload: { ...cases[2].value, variant: 'preview' } },
  { method: 'team.media.authorize.v1', payload: { ...cases[3].value, variant: 'original' } },
  { method: 'team.patch.open.v1', payload: cases[1].value },
]);
const rejected = await legacyApi.openTeamPatch(cases[2].ref);
assert.equal(rejected.success, false, 'open action must reject a returned-media reference');
assert.equal(calls.length, 5, 'invalid open action must not reach RPC');
const hydratedBundle = await legacyApi.getTeamPatches('workspace', '后期中', '项目', '图片后期_1/27.jpg', 'registration-base');
assert.deepEqual(calls.at(-1), { method: 'team.patch.get.v1', payload: { relativePath: '图片后期_1/27.jpg' } }, 'a resolved history card loads its patch bundle by the corresponding relativePath');
assert.deepEqual(parseLegacyMediaRef(hydratedBundle.photo.originalFilePath), { kind: 'original', photoId: 'bundle-photo', baseVersionId: 'registration-base' }, 'original preview uses the registered base rather than the newer current version');
assert.deepEqual(parseLegacyMediaRef(hydratedBundle.tasks[0].patchPath), { kind: 'working', photoId: 'bundle-photo', baseVersionId: 'registration-base', taskId: 'bundle-task' });

const fixture = { photos: Array.from({ length: 27 }, (_, photoIndex) => ({ photoId: `fixture-photo-${photoIndex + 1}`, baseVersionId: `fixture-base-${photoIndex + 1}`, tasks: Array.from({ length: photoIndex < 25 ? 3 : 2 }, (_value, taskIndex) => ({ id: `fixture-task-${photoIndex + 1}-${taskIndex + 1}`, baseVersionId: `fixture-base-${photoIndex + 1}` })) })) };
const requests = legacyPreviewRequests(fixture);
failedTaskId = 'fixture-task-14-2';
const results = [];
for (const request of requests) {
  const reference = request.kind === 'original' ? legacyMediaRef('original', request.photoId, request.baseVersionId) : legacyMediaRef('working', request.photoId, request.baseVersionId, request.taskId);
  try {
    const result = request.kind === 'original' ? await legacyApi.getMediaOriginal(reference) : await legacyApi.getMediaThumbnail(reference);
    results.push({ success: Boolean(result.mediaUrl || result.previewUrl), error: result.error });
  } catch (error) { results.push({ success: false, error: readableLegacyMediaError(error, request.kind) }); }
}
const summary = summarizeLegacyPreviewResults(requests, results);
assert.deepEqual({ total: summary.total, succeeded: summary.succeeded, failed: summary.failed }, { total: 106, succeeded: 105, failed: 1 }, '27 original and 79 patch authorizations execute independently');
assert.match(summary.failures[0].error, /历史版本不存在|工作图任务不存在|历史预览文件缺失/, 'the failed item keeps a visible actionable diagnostic');
const missingCard = await legacyApi.getMediaThumbnail(legacyMediaRef('working', 'fixture-photo-14', 'fixture-base-14', failedTaskId));
assert.deepEqual({ success: missingCard.success, state: missingCard.state }, { success: false, state: 'MISSING' }, 'expired historical component media degrades to one missing card instead of rejecting the stage');

console.log('Team-retouch legacy media reference round-trip tests passed');
