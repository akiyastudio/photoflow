const assert = require('node:assert/strict');
const { runPublishStateMachine } = require('./release-publish-state.cjs');

const scenario = async faults => {
  const states = []; const calls = [];
  const step = name => { calls.push(name); if (faults[name]) throw new Error(`fault:${name}`); };
  const promise = runPublishStateMachine({
    writeInitialPending: state => { step('attempt'); states.push(state.state); },
    prepareLocalRecord: () => step('prepared'),
    publishRemote: () => step('remote'),
    promoteLocalRecord: () => step(faults.existingDraft ? 'backup' : 'promote'),
    assertArtifactsUnchanged: () => step('fence'),
    writeState: state => { step(state.state === 'committed' ? 'committed-write' : 'failure-write'); states.push(state.state); },
  });
  return { promise, states, calls };
};

(async () => {
  let run = await scenario({}); assert.deepEqual(await run.promise, { state: 'committed' }); assert.deepEqual(run.states, ['pending', 'committed']);
  run = await scenario({ prepared: true }); await assert.rejects(run.promise, /fault:prepared/); assert.deepEqual(run.states, ['pending']); assert(!run.calls.includes('remote'));
  run = await scenario({ attempt: true }); await assert.rejects(run.promise, /fault:attempt/); assert(!run.calls.includes('remote'));
  run = await scenario({ existingDraft: true, backup: true }); await assert.rejects(run.promise, error => error.releaseState === 'remote-saved-local-pending'); assert.deepEqual(run.states, ['pending', 'remote-saved-local-pending']);
  run = await scenario({ promote: true }); await assert.rejects(run.promise, error => error.releaseState === 'remote-saved-local-pending');
  run = await scenario({ fence: true }); await assert.rejects(run.promise, error => error.releaseState === 'remote-saved-artifacts-changed'); assert.deepEqual(run.states, ['pending', 'remote-saved-artifacts-changed']);
  run = await scenario({ 'committed-write': true }); await assert.rejects(run.promise, error => error.releaseState === 'remote-saved-local-pending'); assert.deepEqual(run.states, ['pending', 'remote-saved-local-pending']);
  console.log('Release publish state-machine fault injection tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
