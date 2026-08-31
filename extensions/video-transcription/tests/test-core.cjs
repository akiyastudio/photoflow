const assert = require('node:assert/strict');
const { normalizeDialogInputs, isSupportedMediaName, srtNameFor, normalizeSettings, redactError, parseSrt, operationSnapshot } = require('../core.cjs');

assert.equal(isSupportedMediaName('A.MP4'), true);
assert.equal(isSupportedMediaName('note.txt'), false);
assert.deepEqual(normalizeDialogInputs([{ name: 'a.MP4', token: 'component-input:one' }, { name: 'skip.exe', token: 'component-input:two' }, { name: 'x.wav', relativeName: '../nested/x.wav', token: 'component-input:three' }]).map(item => item.relativeName), ['a.MP4', 'nested/x.wav']);
assert.equal(srtNameFor('folder/movie.mkv'), 'folder/movie.srt');
assert.equal(normalizeSettings({ language: 'auto', device: 'cpu', computeType: 'wat' }).language, null);
assert.equal(normalizeSettings({ model: '../../bad model' }).model, 'large-v3');
assert.equal(normalizeSettings({ device: 'cpu', computeType: 'wat' }).computeType, 'int8');
assert(!redactError('failed at C:\\secret\\input.mp4').includes('C:\\secret'));

const segments = parseSrt('\uFEFF1\r\n00:00:01,250 --> 00:00:02,500\r\n第一行\r\n\r\n2\n01:01:01.000 --> 01:01:02.250\n第二行\n继续');
assert.deepEqual(segments, [
  { seq: 1, start: 1.25, end: 2.5, text: '第一行' },
  { seq: 2, start: 3661, end: 3662.25, text: '第二行\n继续' },
]);
assert.deepEqual(parseSrt('bad data'), []);

const operation = { id: 'op', state: 'completed', sourceKind: 'project-media', createdAt: 1, updatedAt: 2, error: '', files: [{ id: 'f', operationId: 'op', ordinal: 0, displayName: 'a.mp4', relativeName: 'a.mp4', sourceKind: 'project-media', state: 'completed', progress: 100, error: '', language: 'zh', segmentCount: 2, output: { relativePath: 'a.srt' } }] };
const snapshot = operationSnapshot(operation);
assert.equal(snapshot.succeeded, 1);
assert.equal(snapshot.failed, 0);
assert.equal(snapshot.files[0].output.relativePath, 'a.srt');
assert(!Object.hasOwn(snapshot.files[0], 'privatePath'));
console.log('video-transcription core filtering, SRT parsing, and in-memory snapshot tests passed');
