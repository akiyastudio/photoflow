import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const calls = [];
globalThis.window = {
  photoFlowComponent: {
    contractVersion: 1,
    rpc: async (method, payload) => { calls.push({ method, payload }); return { success: true, url: `photoflow-media:test/${calls.length}` }; },
    onEvent: () => () => undefined,
    onActivate: () => () => undefined,
    onDeactivate: () => () => undefined,
    getContext: async () => ({}),
  },
};

const modulePath = pathToFileURL(path.resolve('extensions/team-retouch/renderer/src/legacy/legacy-api.ts')).href;
const { legacyApi, legacyMediaRef, parseLegacyMediaRef } = await import(modulePath);
const cases = [
  { ref: legacyMediaRef('original', '照片:一/1', '版本 % 1'), value: { kind: 'original', photoId: '照片:一/1', baseVersionId: '版本 % 1' } },
  { ref: legacyMediaRef('working', 'photo:2', 'base/2', 'task % 2'), value: { kind: 'working', photoId: 'photo:2', baseVersionId: 'base/2', taskId: 'task % 2' } },
  { ref: legacyMediaRef('returned', 'photo:3', 'base/3', 'task % 3'), value: { kind: 'returned', photoId: 'photo:3', baseVersionId: 'base/3', taskId: 'task % 3' } },
  { ref: legacyMediaRef('review-return', '', '', '', 'session:四', 'return/4'), value: { kind: 'review-return', reviewSessionId: 'session:四', returnId: 'return/4' } },
];
for (const item of cases) assert.deepEqual(parseLegacyMediaRef(item.ref), item.value, `${item.value.kind} reference must round-trip`);
for (const invalid of ['', 'photoflow-ref:original:photo:version', 'photoflow-ref:unknown:a:b:c:d:e', 'photoflow-ref:working:p:v:::', 'photoflow-ref:original:%E0%A4%A:v:::', `${cases[0].ref}:extra`]) assert.equal(parseLegacyMediaRef(invalid), undefined, `malformed reference must be rejected: ${invalid}`);

assert.equal((await legacyApi.getMediaOriginal(cases[0].ref)).mediaUrl, 'photoflow-media:test/1');
assert.equal((await legacyApi.getMediaThumbnail(cases[1].ref)).previewUrl, 'photoflow-media:test/2');
assert.equal((await legacyApi.getMediaThumbnail(cases[2].ref)).previewUrl, 'photoflow-media:test/3');
assert.equal((await legacyApi.getMediaOriginal(cases[3].ref)).mediaUrl, 'photoflow-media:test/4');
assert.equal((await legacyApi.openTeamPatch(cases[1].ref)).success, true);
assert.deepEqual(calls, [
  { method: 'team.media.authorize.v1', payload: cases[0].value },
  { method: 'team.media.authorize.v1', payload: cases[1].value },
  { method: 'team.media.authorize.v1', payload: cases[2].value },
  { method: 'team.media.authorize.v1', payload: cases[3].value },
  { method: 'team.patch.open.v1', payload: cases[1].value },
]);
const rejected = await legacyApi.openTeamPatch(cases[2].ref);
assert.equal(rejected.success, false, 'open action must reject a returned-media reference');
assert.equal(calls.length, 5, 'invalid open action must not reach RPC');

console.log('Team-retouch legacy media reference round-trip tests passed');
