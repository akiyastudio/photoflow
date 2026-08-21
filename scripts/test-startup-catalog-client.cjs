const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'platform', 'workspace-catalog-client.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const values = new Map();
const events = [];
let requests = 0;
const response = { success: true, root: 'D:/照片流', statuses: [{ status: '未分类', projects: [] }] };
const mockWindow = {
  localStorage: {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  },
  electronAPI: {
    getWorkspaceProjects: async () => {
      requests += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return response;
    },
  },
  dispatchEvent: event => { events.push(event); return true; },
};

class MockCustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
}

const moduleValue = { exports: {} };
new Function('module', 'exports', 'require', 'window', 'CustomEvent', compiled)(moduleValue, moduleValue.exports, require, mockWindow, MockCustomEvent);
const { getWorkspaceCatalog, readWorkspaceCatalogSnapshot } = moduleValue.exports;

const run = async () => {
  const [left, right] = await Promise.all([
    getWorkspaceCatalog('D:/照片流'),
    getWorkspaceCatalog('D:/照片流'),
  ]);
  assert.deepEqual(left, response);
  assert.deepEqual(right, response);
  assert.equal(requests, 1, 'simultaneous catalog consumers must share one request');
  assert.deepEqual(readWorkspaceCatalogSnapshot('D:\\照片流'), response, 'resolved roots must alias the same memory snapshot');
  assert(values.has('photoflow:workspace-catalog-snapshots:v1'), 'successful catalogs must persist for the next cold start');
  assert.equal(events.filter(event => event.type === 'workspace-catalog-snapshot-changed').length, 1);

  const stale = await getWorkspaceCatalog('D:/照片流');
  assert.deepEqual(stale, response, 'a warm consumer must receive the stale snapshot without waiting');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests, 2, 'serving a snapshot must still revalidate once in the background');

  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  mockWindow.electronAPI.getWorkspaceProjects = async () => { throw new Error('simulated IPC disconnect'); };
  const offlineSnapshot = await getWorkspaceCatalog('D:/照片流');
  assert.deepEqual(offlineSnapshot, response, 'a failed background revalidation must preserve the startup snapshot');
  await new Promise(resolve => setTimeout(resolve, 20));
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled.length, 0, 'a detached revalidation failure must not become an unhandled rejection');
  process.stdout.write('Startup catalog client tests passed.\n');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
