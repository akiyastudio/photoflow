import assert from 'node:assert/strict';
// Plugin-owned regression test; runnable without the PhotoFlow source tree.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let status = { success: true, advancedAvailable: true, available: true, installed: true, state: 'ready', advancedError: '' };
const rpcMethods = [];
globalThis.window = {
  photoFlowComponent: {
    contractVersion: 1,
    rpc: async method => {
      rpcMethods.push(method); assert.equal(method, 'team.advanced.status.v1');
      return status;
    },
    onEvent: () => () => undefined,
    onActivate: () => () => undefined,
    onDeactivate: () => () => undefined,
    getContext: async () => ({}),
  },
};

const modulePath = pathToFileURL(path.resolve('renderer/src/legacy/legacy-api.ts')).href;
const { componentStatusFromAdvancedPreflight, legacyApi } = await import(modulePath);

assert.deepEqual(
  componentStatusFromAdvancedPreflight(status),
  { id: 'team-retouch', installed: true, runtimeAvailable: true, identityAvailable: true, advancedAvailable: true, advancedState: 'ready', advancedError: '', provider: '内置人物检测' },
  'the explicit lifecycle status contract maps to an available advanced detector',
);
assert.equal(componentStatusFromAdvancedPreflight({ success: true, message: 'prerequisites passed' }).advancedAvailable, false, 'prerequisite success alone must never claim that the advanced runtime is installed');
assert.equal(componentStatusFromAdvancedPreflight({ success: true, message: 'checking' }).advancedState, undefined, 'unknown/checking metadata must never be reported as not installed');
assert.equal(componentStatusFromAdvancedPreflight({ success: true, installed: true }).advancedAvailable, true, 'the reviewed legacy installed field remains compatible');
assert.equal(componentStatusFromAdvancedPreflight({ success: true, installed: true, advancedAvailable: false, state: 'repair-needed', advancedError: 'service failed' }).advancedAvailable, false, 'the explicit runtime result takes precedence over legacy installed metadata');
assert.deepEqual(
  componentStatusFromAdvancedPreflight({ success: true, advancedAvailable: false, state: 'unavailable', errorCategory: 'wsl-access-denied', runtimeSource: 'development' }),
  { id: 'team-retouch', installed: true, runtimeAvailable: true, identityAvailable: true, advancedAvailable: false, advancedState: 'unavailable', advancedError: '', advancedErrorCategory: 'wsl-access-denied', advancedRuntimeSource: 'development', provider: '内置人物检测' },
);

const listed = await legacyApi.getComponents();
assert.equal(listed.components[0].advancedAvailable, true);
assert.equal(listed.components[0].advancedState, 'ready');
status = { success: true, advancedAvailable: false, installed: false, state: 'not-installed', advancedError: '增强人物检测尚未安装' };
const repair = await legacyApi.getComponents();
assert.deepEqual({ available: repair.components[0].advancedAvailable, state: repair.components[0].advancedState, error: repair.components[0].advancedError }, { available: false, state: 'not-installed', error: '增强人物检测尚未安装' });
assert(rpcMethods.every(method => method === 'team.advanced.status.v1'), 'page-open advanced status must never invoke lifecycle preflight');

console.log('Team-retouch advanced status contract tests passed');
