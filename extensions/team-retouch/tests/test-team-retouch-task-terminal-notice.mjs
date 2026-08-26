import assert from 'node:assert/strict';
import { shouldEmitTerminalToast, terminalFeedbackOwner } from '../renderer/src/task-terminal-notice-model.ts';

for (const outcome of ['completed', 'failed', 'cancelled']) {
  assert.equal(terminalFeedbackOwner({ presentation: 'visible', outcome }), 'task', `visible task ${outcome} must own its terminal feedback`);
  assert.equal(shouldEmitTerminalToast({ presentation: 'visible', outcome }), false);
}
assert.equal(shouldEmitTerminalToast({ presentation: 'silent', outcome: 'failed' }), true, 'silent single-image task failures still need a toast');
assert.equal(shouldEmitTerminalToast({ presentation: 'none', outcome: 'failed' }), true, 'preflight and non-task failures still need a toast');
assert.equal(shouldEmitTerminalToast({ presentation: 'none', outcome: 'cancelled' }), true, 'cancellation before a visible task exists keeps renderer feedback');

console.log('Team-retouch terminal task feedback policy tests passed');
