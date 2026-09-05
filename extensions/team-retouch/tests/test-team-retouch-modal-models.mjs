import assert from 'node:assert/strict';
import { createDialogQueue } from '../renderer/src/legacy/dialog-queue-model.ts';
import { createModalStack, nextFocusIndex } from '../renderer/src/legacy/modal-stack-model.ts';

const closed = [];
const stack = createModalStack();
const base = stack.register(() => closed.push('base'));
const busy = stack.register(() => closed.push('busy'), false);
assert.notEqual(base, busy, 'every layer receives a unique token');
assert.equal(stack.escape(), false, 'a busy top layer rejects Escape');
assert.deepEqual(closed, []);
stack.update(busy, () => closed.push('choice'), true);
assert.equal(stack.escape(), true);
assert.deepEqual(closed, ['choice'], 'only the top layer closes');
stack.unregister(busy);
stack.escape();
assert.deepEqual(closed, ['choice', 'base']);

assert.equal(nextFocusIndex(3, 2), 0);
assert.equal(nextFocusIndex(3, 0, true), 2);
assert.equal(nextFocusIndex(3, -1, true), 2);
assert.equal(nextFocusIndex(0, 0), -1);

const queue = createDialogQueue();
const answers = [];
const first = queue.ask({ kind: 'choice', tone: 'danger', defaultValue: 'discard', cancelDefault: true, dismissible: false }).then(value => answers.push(['first', value]));
const second = queue.ask({ kind: 'prompt', defaultValue: '人物 1' }).then(value => answers.push(['second', value]));
assert.equal(queue.size(), 2);
const firstToken = queue.current().token;
assert.deepEqual(queue.current().request, { kind: 'choice', tone: 'danger', defaultValue: 'discard', cancelDefault: true, dismissible: false });
assert.equal(queue.settle(firstToken, null), true);
assert.equal(queue.settle(firstToken, 'discard'), false, 'each promise resolves exactly once');
const secondToken = queue.current().token;
assert.equal(queue.settle(secondToken, '人物 2'), true);
await Promise.all([first, second]);
assert.deepEqual(answers, [['first', null], ['second', '人物 2']], 'requests remain FIFO and retain choice/default/cancel semantics');

console.log('Team-retouch modal model tests passed');
