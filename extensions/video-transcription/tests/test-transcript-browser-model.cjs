const assert = require('node:assert/strict');
const model = require('../ui/transcript-browser-model.js');
const files = [
  { id: 'b', relativeName: 'Folder/Nested/b.mp4', state: 'running', progress: 42, segmentCount: 2, output: {} },
  { id: 'a', relativeName: 'Folder/a.mp4', state: 'completed', progress: 100, segmentCount: 2, output: {} },
  { id: 'c', relativeName: 'root.mp4', state: 'failed', progress: 100, error: '真实失败', segmentCount: 0, output: {} },
];
const tree = model.buildTree(files);
assert.equal(tree.children[0].type, 'folder'); assert.equal(tree.children[0].name, 'Folder'); assert.equal(tree.children[0].children[0].type, 'folder');
assert.equal(model.defaultFileId(files), 'a', 'first completed file is selected by default'); assert.equal(model.defaultFileId(files, 'b'), 'b');
assert.equal(model.transcriptKey(files[0]), 'b\u0000running\u00002\u00000');
const text = model.transcriptText([{ start: 1.25, end: 2.5, text: '第一行' }, { start: 3661, end: 3662, text: '第二行' }]);
assert.match(text, /00:00:01,250 – 00:00:02,500/); assert.match(text, /01:01:01,000/); assert.match(text, /第一行\n\n/);
assert.equal(model.operationSignature({ id: 'op', state: 'running', total: 3, succeeded: 1, failed: 1, files }), model.operationSignature({ id: 'op', state: 'running', total: 3, succeeded: 1, failed: 1, files }));
assert.notEqual(model.fileSignature(files[0]), model.fileSignature({ ...files[0], progress: 43 }));
assert.equal(model.segmentKey('a', 9), 'a:9', 'search targets use a stable exact segment key');
assert.equal(model.boundedPage(Array.from({ length: 500 }, (_, index) => index), 120).length, 120, 'all-transcript rendering is bounded to one page');
assert.equal(model.boundedPage(Array.from({ length: 500 }, (_, index) => index), 500).length, 200, 'the model enforces an absolute DOM page ceiling');
console.log('video-transcription directory tree, search targeting, and bounded transcript model tests passed');
