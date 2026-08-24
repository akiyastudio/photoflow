import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let preflight = { success: true, advancedAvailable: true, available: true, installed: true, state: 'ready', advancedError: '' };
globalThis.window = {
  photoFlowComponent: {
    contractVersion: 1,
    rpc: async method => {
      assert.equal(method, 'team.advanced.preflight.v1');
      return preflight;
    },
    onEvent: () => () => undefined,
    onActivate: () => () => undefined,
    onDeactivate: () => () => undefined,
    getContext: async () => ({}),
  },
};

const modulePath = pathToFileURL(path.resolve('extensions/team-retouch/renderer/src/legacy/legacy-api.ts')).href;
const { componentStatusFromAdvancedPreflight, legacyApi } = await import(modulePath);

assert.deepEqual(
  componentStatusFromAdvancedPreflight(preflight),
  { id: 'team-retouch', installed: true, runtimeAvailable: true, identityAvailable: true, advancedAvailable: true, advancedState: 'ready', advancedError: '', provider: '内置人物检测' },
  'the explicit lifecycle status contract maps to an available advanced detector',
);
assert.equal(componentStatusFromAdvancedPreflight({ success: true, message: 'prerequisites passed' }).advancedAvailable, false, 'prerequisite success alone must never claim that the advanced runtime is installed');
assert.equal(componentStatusFromAdvancedPreflight({ success: true, message: 'checking' }).advancedState, undefined, 'unknown/checking metadata must never be reported as not installed');
assert.equal(componentStatusFromAdvancedPreflight({ success: true, installed: true }).advancedAvailable, true, 'the reviewed legacy installed field remains compatible');
assert.equal(componentStatusFromAdvancedPreflight({ success: true, installed: true, advancedAvailable: false, state: 'repair-needed', advancedError: 'service failed' }).advancedAvailable, false, 'the explicit runtime result takes precedence over legacy installed metadata');

const listed = await legacyApi.getComponents();
assert.equal(listed.components[0].advancedAvailable, true);
assert.equal(listed.components[0].advancedState, 'ready');
preflight = { success: true, preflightPassed: true, advancedAvailable: false, installed: true, state: 'repair-needed', advancedError: 'SAM service missing' };
const repair = await legacyApi.getComponents();
assert.deepEqual({ available: repair.components[0].advancedAvailable, state: repair.components[0].advancedState, error: repair.components[0].advancedError }, { available: false, state: 'repair-needed', error: 'SAM service missing' });
preflight = { success: false, error: 'preflight timeout' };
await assert.rejects(legacyApi.getComponents(), /preflight timeout/, 'status failures remain retryable errors instead of becoming not-installed');

console.log('Team-retouch advanced status contract tests passed');
