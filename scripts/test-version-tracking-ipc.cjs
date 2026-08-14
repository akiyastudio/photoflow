const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerVersionIpc } = require('../electron/modules/versions-ipc.cjs');
const { createMediaRepository } = require('../electron/repositories/media-repository.cjs');

const handlers = new Map();
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-version-ipc-'));
const trustedParent = path.join(workspaceRoot, 'Project', 'source');
const trustedProgress = path.join(workspaceRoot, 'Project', 'edit');
fs.mkdirSync(trustedParent, { recursive: true });
fs.mkdirSync(trustedProgress, { recursive: true });
const calls = {};
const taskReports = [];

const versionService = {
  createTrackingSession: async (root, request) => {
    calls.created = { root, request };
    if (calls.createTrackingResponses?.length) return calls.createTrackingResponses.shift();
    return {
      sessionId: '11111111-1111-4111-8111-111111111111',
      progressId: request.progressId,
      parentProgressId: 'parent-progress-id',
      mode: request.mode,
      parentFolderPath: trustedParent,
      progressFolderPath: trustedProgress,
    };
  },
  prepareTracking: async (root, request) => {
    calls.prepare = { root, request };
    return {
      sessionId: '11111111-1111-4111-8111-111111111111',
      progressId: request.progressId,
      parentProgressId: 'parent-progress-id',
      mode: request.mode,
      parentFolderPath: trustedParent,
      progressFolderPath: trustedProgress,
      sourceNames: ['new.jpg'],
      removedNames: [],
      copyCandidateNames: [],
    };
  },
  storeTrackingPreview: async (root, request) => {
    calls.preview = { root, request };
    return { success: true, session: { id: request.sessionId }, items: request.items };
  },
  getTrackingCommitPlan: async (root, sessionId) => {
    calls.plan = { root, sessionId };
    return {
      sessionId,
      mode: 'refresh',
      projectName: 'Project',
      progressId: 'progress-node-id',
      parentProgressId: 'parent-progress-id',
      parentFolderPath: trustedParent,
      progressFolderPath: trustedProgress,
      displayName: 'edit',
      renameFromParent: true,
      copyMissingFromParent: false,
      matches: [{ reference: 'base.jpg', source: 'new.jpg', target: 'base.jpg' }],
      incrementalSources: ['new.jpg'],
      copyReferences: [],
    };
  },
  commitBatchCompare: async (root, request) => {
    calls.commit = { root, request };
    return { success: true, batch: { id: 'batch-id' }, renamedCount: 1 };
  },
  completeTrackingCommit: async (root, request) => ({
    success: true,
    session: { id: request.sessionId, status: 'committed' },
    items: [],
  }),
  failTrackingCommit: async () => ({ success: true }),
  releaseTrackingSession: async (_root, sessionId) => {
    (calls.releasedSessions ||= []).push(sessionId);
    return { success: true, released: true, sessionId };
  },
  registerProgress: async (_root, request) => ({ success: true, progressFolder: { id: 'registered-node', ...request } }),
};
const mediaScanService = {
  prepareTracking: (root, request) => versionService.prepareTracking(root, request),
  completeTrackingCommit: async (root, request) => {
    calls.complete = { root, request };
    return { success: true, session: { id: request.sessionId, status: 'committed' }, items: [] };
  },
};

registerVersionIpc({
  Array,
  Boolean,
  Error,
  IMAGE_EXTENSIONS: new Set(['.jpg']),
  JSON,
  Math,
  Number,
  RAW_EXTENSIONS: new Set(),
  Set,
  String,
  VIDEO_EXTENSIONS: new Set(),
  backgroundTasks: {
    create: () => ({
      context: { signal: new AbortController().signal, report: (...args) => taskReports.push(args), throwIfCancelled: () => undefined },
      waitForStart: async () => undefined, complete: () => undefined, fail: () => undefined, cancelled: () => undefined,
    }),
    list: () => calls.activeTasks || [],
  },
  copyFileAtomic: async () => undefined,
  crypto,
  ensureWorkspace: value => {
    assert.strictEqual(value, workspaceRoot);
    return workspaceRoot;
  },
  fs,
  getWorkspaceDataRoot: root => path.join(root, '.photoflow-test-data'),
  getProjectPath: () => path.join(workspaceRoot, 'Project'),
  ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
  mediaMetadataCache: new Map(),
  mediaScanService,
  path,
  releaseWorkspaceWatchPath: () => undefined,
  refreshWorkspaceCatalog: async () => undefined,
  resolveProjectEntry: (_root, _status, _projectName, relativePath) => {
    const projectPath = path.join(workspaceRoot, 'Project');
    const resolved = path.resolve(projectPath, String(relativePath || ''));
    assert(resolved.startsWith(`${projectPath}${path.sep}`));
    return resolved;
  },
  runPythonEventAction: async (_script, args, _timeout, _signal, onEvent) => {
    calls.pythonArgs = args;
    const progressEvent = { type: 'progress', progress: 50, message: 'matching' };
    onEvent?.(progressEvent);
    return [progressEvent, { type: 'preview', data: { matches: [], suggestions: [], unmatched: ['new.jpg'] } }];
  },
  shell: { readShortcutLink: shortcutPath => JSON.parse(fs.readFileSync(shortcutPath, 'utf8')) },
  suppressWorkspaceWatchPath: () => undefined,
  undefined,
  versionService,
  workspaceCatalogs: new Map([[workspaceRoot, {}]]),
  writeLog: () => undefined,
});

async function main() {
  let repositoryCall;
  const repository = createMediaRepository({ call: (...args) => { repositoryCall = args; return Promise.resolve({ success: true }); } });
  await repository.prepareTracking(workspaceRoot, { progressId: 'timeout-test' });
  assert.deepStrictEqual(repositoryCall, [workspaceRoot, 'tracking_prepare', { progressId: 'timeout-test' }, 30 * 60 * 1000], 'tracking preparation must use the long folder-snapshot timeout');
  await repository.completeTrackingCommit(workspaceRoot, { sessionId: 'timeout-test' });
  assert.deepStrictEqual(repositoryCall, [workspaceRoot, 'tracking_commit_complete', { sessionId: 'timeout-test' }, 30 * 60 * 1000], 'tracking finalization must use the long filesystem-snapshot timeout');

  const start = handlers.get('workspace-progress-tracking-start');
  const commit = handlers.get('workspace-progress-tracking-commit');
  assert(start && commit, 'V2 tracking handlers must be registered');

  const maliciousPath = path.resolve('C:\\outside\\attack');
  const started = await start({}, workspaceRoot, 'Project', {
    progressId: 'progress-node-id',
    mode: 'refresh',
    folderA: maliciousPath,
    folderB: maliciousPath,
    parentProgressId: 'renderer-parent-attack',
  });
  assert.strictEqual(started.success, true);
  for (let attempt = 0; attempt < 50 && !calls.preview; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepStrictEqual(calls.prepare.request, {
    projectName: 'Project', progressId: 'progress-node-id', mode: 'refresh',
    sessionId: '11111111-1111-4111-8111-111111111111',
  });
  assert(calls.pythonArgs.includes(trustedParent) && calls.pythonArgs.includes(trustedProgress));
  assert(calls.pythonArgs.includes('--source_files_file'), 'large source lists must use a manifest instead of the Windows command line');
  assert(taskReports.some(([progress, message, metadata]) => progress === 0 && message === '正在读取版本媒体' && metadata.processedCount === 0), 'reading must begin at a truthful zero percent');
  assert(taskReports.some(([progress, message, metadata]) => progress === 40 && message === 'matching' && metadata.processedCount === 1), 'streamed worker progress must update the background task before completion');
  assert(!calls.pythonArgs.includes(maliciousPath), 'renderer paths must never reach the compare tool');
  assert.strictEqual(calls.preview.request.items[0].status, 'pending_confirmation');

  calls.createTrackingResponses = [{
    sessionId: '22222222-2222-4222-8222-222222222222', progressId: 'progress-node-id',
    parentProgressId: 'parent-progress-id', mode: 'refresh', sessionStatus: 'pending_confirm', reused: true,
    parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }];
  const resumedConfirmation = await start({}, workspaceRoot, 'Project', { progressId: 'progress-node-id', mode: 'refresh' });
  assert.deepStrictEqual(resumedConfirmation, {
    success: true, sessionId: '22222222-2222-4222-8222-222222222222', sessionStatus: 'pending_confirm', resumed: true,
  }, 'a pending confirmation must be resumed instead of creating a second session');

  calls.createTrackingResponses = [{
    sessionId: '33333333-3333-4333-8333-333333333333', progressId: 'progress-node-id',
    parentProgressId: 'parent-progress-id', mode: 'refresh', sessionStatus: 'comparing', reused: true,
    parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }];
  calls.activeTasks = [{ id: 'active-tracking-task', type: 'version-tracking', state: 'running', metadata: { sessionId: '33333333-3333-4333-8333-333333333333' } }];
  const resumedRunning = await start({}, workspaceRoot, 'Project', { progressId: 'progress-node-id', mode: 'refresh' });
  assert.strictEqual(resumedRunning.taskId, 'active-tracking-task', 'a live compare task must be reused');
  assert.strictEqual(resumedRunning.sessionId, '33333333-3333-4333-8333-333333333333');
  calls.activeTasks = [];

  calls.createTrackingResponses = [{
    sessionId: '44444444-4444-4444-8444-444444444444', progressId: 'progress-node-id',
    parentProgressId: 'parent-progress-id', mode: 'refresh', sessionStatus: 'comparing', reused: true,
    parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }, {
    sessionId: '55555555-5555-4555-8555-555555555555', progressId: 'progress-node-id',
    parentProgressId: 'parent-progress-id', mode: 'refresh', sessionStatus: 'comparing', reused: false,
    parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }];
  const restartedOrphan = await start({}, workspaceRoot, 'Project', { progressId: 'progress-node-id', mode: 'refresh' });
  assert.strictEqual(restartedOrphan.sessionId, '55555555-5555-4555-8555-555555555555', 'an orphaned comparing row must be replaced');
  assert(calls.releasedSessions.includes('44444444-4444-4444-8444-444444444444'));

  const release = handlers.get('workspace-progress-tracking-session-release');
  const released = await release({}, workspaceRoot, { sessionId: started.sessionId });
  assert.deepStrictEqual(released, { success: true, released: true, sessionId: started.sessionId });

  const committed = await commit({}, workspaceRoot, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    folderA: maliciousPath,
    folderB: maliciousPath,
    matches: [{ reference: '..\\attack.jpg', source: 'attack.jpg' }],
  });
  assert.strictEqual(committed.success, true);
  assert.strictEqual(calls.commit.request.folderA, trustedParent);
  assert.strictEqual(calls.commit.request.folderB, trustedProgress);
  assert.deepStrictEqual(calls.commit.request.matches, [
    { reference: 'base.jpg', source: 'new.jpg', target: 'base.jpg' },
  ]);
  assert.deepStrictEqual(calls.complete, {
    root: workspaceRoot,
    request: { sessionId: '11111111-1111-4111-8111-111111111111', batchId: 'batch-id' },
  }, 'tracking snapshot finalization must use the isolated media-scan database worker');
  assert(!JSON.stringify(calls.commit.request).includes(maliciousPath));

  let commitAttempts = 0;
  let failureRecorded = 0;
  versionService.commitBatchCompare = async (root, request) => {
    commitAttempts += 1;
    calls.commit = { root, request };
    if (commitAttempts === 1) throw new Error('simulated atomic commit failure');
    return { success: true, batch: { id: 'retry-batch-id' }, renamedCount: 1 };
  };
  versionService.failTrackingCommit = async () => {
    failureRecorded += 1;
    return { success: true };
  };
  const failed = await commit({}, workspaceRoot, { sessionId: '22222222-2222-4222-8222-222222222222' });
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.retryable, true);
  assert.strictEqual(failureRecorded, 1);
  const retried = await commit({}, workspaceRoot, { sessionId: '22222222-2222-4222-8222-222222222222' });
  assert.strictEqual(retried.success, true);
  assert.strictEqual(commitAttempts, 2);
  assert.strictEqual(calls.commit.request.folderA, trustedParent);
  assert.strictEqual(calls.commit.request.folderB, trustedProgress);

  versionService.createTrackingSession = async () => { throw new Error('auxiliary nodes cannot be tracked'); };
  const auxiliary = await start({}, workspaceRoot, 'Project', {
    progressId: 'auxiliary-node-id', mode: 'refresh',
  });
  assert.strictEqual(auxiliary.success, false);
  assert.match(auxiliary.error, /auxiliary/);

  const register = handlers.get('workspace-progress-register');
  const externalProgressPath = path.join(workspaceRoot, 'external-progress');
  const externalShortcutPath = path.join(workspaceRoot, 'Project', 'external-progress.lnk');
  fs.mkdirSync(externalProgressPath, { recursive: true });
  fs.writeFileSync(externalShortcutPath, JSON.stringify({ target: externalProgressPath, description: 'PhotoFlow 外链文件夹：external-progress' }));
  let externalRegistrationRequest;
  versionService.registerProgress = async (_root, request) => {
    externalRegistrationRequest = request;
    return { success: true, progressFolder: { id: 'external-node', ...request } };
  };
  const externalRegistration = await register({}, workspaceRoot, 'active', 'Project', {
    relativePath: 'external-progress.lnk', mediaKind: 'image', versionKey: '1',
    displayName: 'external-progress', nodeRole: 'progress', relationKind: 'main', trackingEnabled: true,
  });
  assert.strictEqual(externalRegistration.success, true, externalRegistration.error);
  assert.strictEqual(externalRegistration.relativePath, 'external-progress.lnk');
  assert.strictEqual(externalRegistrationRequest.folderPath, externalProgressPath, 'external progress tracking must persist the shortcut target path');

  const failedNested = path.join(workspaceRoot, 'Project', 'nested', 'Rollback me');
  fs.mkdirSync(failedNested, { recursive: true });
  versionService.registerProgress = async () => { throw new Error('simulated database failure'); };
  const failedRegistration = await register({}, workspaceRoot, 'active', 'Project', {
    relativePath: path.join('nested', 'Rollback me'), mediaKind: 'image', versionKey: 'arbitrary-child',
    displayName: 'Rollback me', nodeRole: 'progress', relationKind: 'main',
    parentProgressId: 'parent-progress-id', trackingEnabled: true, moveToRoot: true,
  });
  assert.strictEqual(failedRegistration.success, false);
  assert.strictEqual(fs.existsSync(failedNested), true, 'a failed DB registration must restore the nested source folder');
  assert.strictEqual(fs.existsSync(path.join(workspaceRoot, 'Project', 'Rollback me')), false);

  const successfulNested = path.join(workspaceRoot, 'Project', 'nested', 'Move me');
  fs.mkdirSync(successfulNested, { recursive: true });
  versionService.registerProgress = async (_root, request) => ({ success: true, progressFolder: { id: 'moved-node', ...request } });
  const successfulRegistration = await register({}, workspaceRoot, 'active', 'Project', {
    relativePath: path.join('nested', 'Move me'), mediaKind: 'image', versionKey: 'not-derived-from-parent',
    displayName: 'Move me', nodeRole: 'progress', relationKind: 'main',
    parentProgressId: 'parent-progress-id', trackingEnabled: true, renameFromParent: true,
    copyMissingFromParent: true, moveToRoot: true,
  });
  assert.strictEqual(successfulRegistration.success, true);
  assert.strictEqual(successfulRegistration.relativePath, 'Move me');
  assert.strictEqual(fs.existsSync(successfulNested), false);
  assert.strictEqual(fs.existsSync(path.join(workspaceRoot, 'Project', 'Move me')), true);
  assert.strictEqual(successfulRegistration.progressFolder.versionKey, 'not-derived-from-parent');
  assert.strictEqual(successfulRegistration.progressFolder.renameFromParent, true);
  assert.strictEqual(successfulRegistration.progressFolder.copyMissingFromParent, true);

  console.log('version tracking V2 IPC tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});
