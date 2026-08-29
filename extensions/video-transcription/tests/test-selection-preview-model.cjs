const assert = require('node:assert/strict');
const model = require('../ui/selection-preview-model.js');

assert.deepEqual(model.payloadFor({ scopeRelativePath: 'Library', selectedRelativePaths: ['Library\\Folder', '', null] }), { scopeRelativePath: 'Library', relativePaths: ['Library/Folder'] });
const files = model.previewFiles({ files: [{ displayName: 'b.MOV', relativeName: 'Library/Folder/Nested/b.MOV' }, { displayName: 'a.mp4', relativeName: 'Library/Folder/a.mp4' }] });
assert(files.every(file => file.preview && file.state === 'preview' && file.id.startsWith('selection-preview:')), 'preview files are isolated temporary view models');
const tree = model.buildTree(files); assert.equal(tree.children[0].name, 'Library'); assert.equal(tree.children[0].children[0].name, 'Folder'); assert.deepEqual(tree.children[0].children[0].children.map(item => item.name), ['Nested', 'a.mp4']);

const pending = new Map(); const changes = [];
const controller = model.createController({ load: payload => new Promise((resolve, reject) => pending.set(payload.relativePaths[0], { resolve, reject })), onChange: value => changes.push(value) });
controller.setContext({ scopeRelativePath: '', selectedRelativePaths: ['Old'] });
controller.setContext({ scopeRelativePath: '', selectedRelativePaths: ['New'] });
pending.get('New').resolve({ files: [{ relativeName: 'New/new.mp4', displayName: 'new.mp4' }], total: 1, limit: 2000, limitReached: false });
setImmediate(() => {
  pending.get('Old').resolve({ files: [{ relativeName: 'Old/old.mp4', displayName: 'old.mp4' }], total: 1 });
  setImmediate(() => {
    assert.equal(changes.at(-1).files[0].relativeName, 'New/new.mp4', 'an older preview response cannot replace the latest context');
    controller.setContext({ scopeRelativePath: '', selectedRelativePaths: [] }); assert.equal(changes.at(-1).state, 'empty-selection');
    const failures = []; const failing = model.createController({ load: async () => { throw new Error('Host scan failed'); }, onChange: value => failures.push(value) });
    failing.setContext({ selectedRelativePaths: ['Broken'] }); setImmediate(() => { assert.equal(failures.at(-1).state, 'error'); assert.match(failures.at(-1).error, /Host scan failed/); console.log('video-transcription selection preview model tree, isolation, error, and latest-request-wins tests passed'); });
  });
});
