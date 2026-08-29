const assert = require('node:assert/strict');
const { createAutoStartGate, isSelectionEntry } = require('../ui/auto-start-model.js');

const values = new Map();
const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
const context = { surface: 'project.contextAction', projectId: 'project-1', sourcePageId: 'files', scopeRelativePath: 'video', selectedRelativePaths: ['video/a.mp4'] };
assert.equal(isSelectionEntry(context), true);
assert.equal(isSelectionEntry({ ...context, surface: 'media.contextAction' }), false, 'legacy media actions are not direct entry surfaces');
assert.equal(isSelectionEntry({ ...context, selectedRelativePaths: [] }), false);

const firstView = createAutoStartGate(storage); let starts = 0;
if (firstView.initial(context)) starts += 1;
assert.equal(starts, 1, 'initial project context starts exactly once');
firstView.finish();
assert.equal(firstView.initial(context), false, 'the same document refresh does not restart the selection');
assert.equal(starts, 1, 'onActivate has no gate entry and cannot create work');

assert.equal(firstView.contextChanged(context), true, 'a new Host context event represents a new user invocation'); starts += 1;
assert.equal(firstView.contextChanged(context), false, 'a concurrent duplicate event is suppressed while start is pending');
firstView.finish();
assert.equal(starts, 2);
assert.equal(firstView.contextChanged(context), true, 'a later explicit context event can create one new task'); starts += 1;
firstView.finish();

const refreshedView = createAutoStartGate(storage);
assert.equal(refreshedView.initial(context), false, 'a refreshed View observes the persisted initial-start marker');
assert.equal(starts, 3);
console.log('video-transcription context auto-start gate tests passed');
