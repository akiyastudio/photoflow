const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerVersionIpc } = require('../electron/modules/versions-ipc.cjs');
const { createMediaRepository } = require('../electron/repositories/media-repository.cjs');
const { createProjectVirtualPathService } = require('../electron/services/project-virtual-path-service.cjs');

const handlers = new Map();
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-version-ipc-'));
const trustedParent = path.join(workspaceRoot, 'Project', 'source');
const trustedProgress = path.join(workspaceRoot, 'Project', 'edit');
fs.mkdirSync(trustedParent, { recursive: true });
fs.mkdirSync(trustedProgress, { recursive: true });
const testShell = {
  readShortcutLink: shortcutPath => JSON.parse(fs.readFileSync(shortcutPath, 'utf8')),
  writeShortcutLink: (shortcutPath, details) => { fs.writeFileSync(shortcutPath, JSON.stringify(details)); return true; },
};
const projectVirtualPaths = createProjectVirtualPathService({ shell: testShell, registryPath: path.join(workspaceRoot, 'managed-links.json') });
const calls = {};
const taskReports = [];
let writeLogImplementation = () => undefined;

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
  getTrackingCommitResources: async () => ({
    success: true, parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }),
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
  decideTrackingItem: async (_root, request) => ({ success: true, ...request }),
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
    create: definition => {
      (calls.taskDefinitions ||= []).push(definition);
      const task = { id: definition.id, type: definition.type, state: 'queued', metadata: definition.metadata };
      if (calls.useCreatedTaskRegistry) (calls.createdTaskRegistry ||= []).push(task);
      return ({
      task,
      context: { signal: new AbortController().signal, report: (...args) => taskReports.push(args), throwIfCancelled: () => undefined },
      waitForStart: async () => { task.state = 'running'; },
      complete: () => { task.state = 'completed'; },
      fail: error => { task.state = 'failed'; (calls.taskFailures ||= []).push(error); },
      cancelled: () => { task.state = 'cancelled'; },
      });
    },
    list: () => calls.useCreatedTaskRegistry ? calls.createdTaskRegistry || [] : calls.activeTasks || [],
    run: async (definition, worker) => {
      (calls.commitTaskDefinitions ||= []).push(definition);
      return { result: await worker({ signal: new AbortController().signal, report: () => undefined, throwIfCancelled: () => undefined }) };
    },
  },
  buildVersionBatchImportKey: async () => 'test-version-batch-import-key',
  cleanVersionName: value => String(value || '').trim(),
  copyFileAtomic: async (sourcePath, destinationPath) => fs.promises.copyFile(sourcePath, destinationPath),
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
  projectVirtualPaths,
  releaseWorkspaceWatchPath: value => (calls.releasedWatchPaths ||= []).push(value),
  refreshManagedExternalWatchers: async () => { calls.externalWatcherRefreshes = (calls.externalWatcherRefreshes || 0) + 1; },
  refreshWorkspaceCatalog: async () => { if (calls.failCatalogRefresh) throw new Error('injected catalog refresh failure'); },
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
  shell: testShell,
  suppressWorkspaceWatchPath: value => (calls.suppressedWatchPaths ||= []).push(value),
  supportedVersionFileKind: filePath => path.extname(filePath).toLowerCase() === '.jpg',
  undefined,
  uniqueDestination: (folderPath, fileName) => path.join(folderPath, fileName),
  versionService,
  workspaceCatalogs: new Map([[workspaceRoot, {}]]),
  writeLog: (...args) => writeLogImplementation(...args),
});

async function main() {
  let repositoryCall;
  const repository = createMediaRepository({ call: (...args) => { repositoryCall = args; return Promise.resolve({ success: true }); } });
  await repository.prepareTracking(workspaceRoot, { progressId: 'timeout-test' });
  assert.deepStrictEqual(repositoryCall, [workspaceRoot, 'tracking_prepare', { progressId: 'timeout-test' }, 30 * 60 * 1000], 'tracking preparation must use the long folder-snapshot timeout');
  await repository.completeTrackingCommit(workspaceRoot, { sessionId: 'timeout-test' });
  assert.deepStrictEqual(repositoryCall, [workspaceRoot, 'tracking_commit_complete', { sessionId: 'timeout-test' }, 30 * 60 * 1000], 'tracking finalization must use the long filesystem-snapshot timeout');
  await repository.renameProgressFolder(workspaceRoot, { progressId: 'rename-contract' });
  assert.deepStrictEqual(repositoryCall, [workspaceRoot, 'progress_folder_rename', { progressId: 'rename-contract' }], 'progress folder rename must use the dedicated backend action');
  await repository.renameExternalProgressLinkRoute(workspaceRoot, { progressId: 'external-rename-contract' });
  assert.deepStrictEqual(repositoryCall, [workspaceRoot, 'progress_external_link_route_rename', { progressId: 'external-rename-contract' }], 'external progress alias rename must use the dedicated route action');

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

  const liveCompareSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const originalPrepareForLiveResume = versionService.prepareTracking;
  let markLiveCompareEntered;
  let releaseLiveCompare;
  const liveCompareEntered = new Promise(resolve => { markLiveCompareEntered = resolve; });
  const liveCompareGate = new Promise(resolve => { releaseLiveCompare = resolve; });
  versionService.prepareTracking = async (root, request) => {
    if (request.sessionId === liveCompareSessionId) {
      markLiveCompareEntered();
      await liveCompareGate;
    }
    return { ...await originalPrepareForLiveResume(root, request), sessionId: request.sessionId };
  };
  calls.useCreatedTaskRegistry = true;
  calls.createdTaskRegistry = [];
  calls.createTrackingResponses = [{
    sessionId: liveCompareSessionId, progressId: 'live-progress-node',
    parentProgressId: 'parent-progress-id', mode: 'refresh', sessionStatus: 'comparing', reused: false,
    parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }];
  const firstLiveCompare = await start({}, workspaceRoot, 'Project', { progressId: 'live-progress-node', mode: 'refresh' });
  await liveCompareEntered;
  calls.createTrackingResponses = [{
    sessionId: liveCompareSessionId, progressId: 'live-progress-node',
    parentProgressId: 'parent-progress-id', mode: 'refresh', sessionStatus: 'comparing', reused: true,
    parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }];
  const resumedLiveCompare = await start({}, workspaceRoot, 'Project', { progressId: 'live-progress-node', mode: 'refresh' });
  assert.deepStrictEqual(resumedLiveCompare, {
    success: true, taskId: firstLiveCompare.taskId, sessionId: liveCompareSessionId, sessionStatus: 'comparing', resumed: true,
  }, 'a running compare owned by this handler must resume its live task while the compare lease is held');
  releaseLiveCompare();
  for (let attempt = 0; attempt < 50 && calls.createdTaskRegistry[0]?.state === 'running'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.strictEqual(calls.createdTaskRegistry[0]?.state, 'completed');
  calls.useCreatedTaskRegistry = false;
  versionService.prepareTracking = originalPrepareForLiveResume;

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

  const decide = handlers.get('workspace-progress-tracking-decide');
  const originalDecideTrackingItem = versionService.decideTrackingItem;
  let releaseDecision;
  const decisionGate = new Promise(resolve => { releaseDecision = resolve; });
  versionService.decideTrackingItem = async (_root, request) => {
    await decisionGate;
    return { success: true, ...request };
  };
  const decisionSessionId = '77777777-7777-4777-8777-777777777777';
  const decisionPromise = decide({}, workspaceRoot, {
    sessionId: decisionSessionId,
    itemId: '88888888-8888-4888-8888-888888888888',
    status: 'accepted',
  });
  await Promise.resolve();
  const secondDecision = await decide({}, workspaceRoot, {
    sessionId: decisionSessionId,
    itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    status: 'rejected',
  });
  assert.strictEqual(secondDecision.success, false, 'a second decision must not acquire or release the first decision lease');
  const commitDuringDecision = await commit({}, workspaceRoot, { sessionId: decisionSessionId });
  const releaseDuringDecision = await release({}, workspaceRoot, { sessionId: decisionSessionId });
  assert.strictEqual(commitDuringDecision.success, false, 'commit must not bypass an in-flight decision');
  assert.match(commitDuringDecision.error, /其他操作/);
  assert.strictEqual(releaseDuringDecision.success, false, 'release must not delete a session with an in-flight decision');
  releaseDecision();
  assert.strictEqual((await decisionPromise).success, true);
  const releaseAfterDecision = await release({}, workspaceRoot, { sessionId: decisionSessionId });
  assert.strictEqual(releaseAfterDecision.success, true, 'the decision lease must be released by its owner after completion');
  versionService.decideTrackingItem = originalDecideTrackingItem;

  const originalReleaseTrackingSession = versionService.releaseTrackingSession;
  let finishConcurrentRelease;
  const concurrentReleaseGate = new Promise(resolve => { finishConcurrentRelease = resolve; });
  const releasingSessionId = '99999999-9999-4999-8999-999999999999';
  versionService.releaseTrackingSession = async (_root, sessionId) => {
    if (sessionId === releasingSessionId) await concurrentReleaseGate;
    return { success: true, released: true, sessionId };
  };
  const concurrentRelease = release({}, workspaceRoot, { sessionId: releasingSessionId });
  await Promise.resolve();
  calls.activeTasks = [{
    id: 'queued-releasing-tracking-task', type: 'version-tracking', state: 'queued',
    metadata: { sessionId: releasingSessionId },
  }];
  calls.createTrackingResponses = [{
    sessionId: releasingSessionId, progressId: 'progress-node-id',
    parentProgressId: 'parent-progress-id', mode: 'refresh', sessionStatus: 'pending_confirm', reused: true,
    parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }];
  const startDuringRelease = await start({}, workspaceRoot, 'Project', { progressId: 'progress-node-id', mode: 'refresh' });
  assert.strictEqual(startDuringRelease.success, false, 'a reused session being released must not return its queued active task');
  finishConcurrentRelease();
  await concurrentRelease;
  calls.activeTasks = [];
  versionService.releaseTrackingSession = originalReleaseTrackingSession;

  const originalPrepareTracking = versionService.prepareTracking;
  const originalFailTrackingCommit = versionService.failTrackingCommit;
  let loggedCompareFailureRecorded = 0;
  versionService.prepareTracking = async () => { throw new Error('injected compare failure'); };
  versionService.failTrackingCommit = async (_root, request) => {
    if (request.sessionId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') loggedCompareFailureRecorded += 1;
    return { success: true };
  };
  writeLogImplementation = (level, message) => {
    if (level === 'error' && message === 'Version tracking compare failed') throw new Error('injected tracking log failure');
  };
  calls.createTrackingResponses = [{
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', progressId: 'progress-node-id',
    parentProgressId: 'parent-progress-id', mode: 'refresh', sessionStatus: 'comparing', reused: false,
    parentFolderPath: trustedParent, progressFolderPath: trustedProgress,
  }];
  const failedCompareStart = await start({}, workspaceRoot, 'Project', { progressId: 'progress-node-id', mode: 'refresh' });
  assert.strictEqual(failedCompareStart.success, true);
  for (let attempt = 0; attempt < 50 && loggedCompareFailureRecorded === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  writeLogImplementation = () => undefined;
  assert.strictEqual(loggedCompareFailureRecorded, 1, 'logging failure must not skip failTrackingCommit');
  assert(calls.taskFailures?.some(error => /injected compare failure/.test(error.message)), 'logging failure must not skip background task failure');
  versionService.prepareTracking = originalPrepareTracking;
  versionService.failTrackingCommit = originalFailTrackingCommit;

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
  assert.strictEqual(calls.commitTaskDefinitions[0].resourceAccess, 'write', 'tracking commit must reserve both version folders for writes');
  assert.deepStrictEqual(calls.commitTaskDefinitions[0].resources, [
    { path: trustedParent, access: 'write' },
    { path: trustedProgress, access: 'write' },
    { path: `photoflow-workspace-database/${workspaceRoot}`, access: 'write' },
  ]);
  assert.strictEqual(calls.commitTaskDefinitions[0].notificationPolicy, 'progress-toast', 'detached tracking commits must remain visible while running');
  assert(!JSON.stringify(calls.commit.request).includes(maliciousPath));

  const batchCommit = handlers.get('workspace-version-batch-commit');
  const copiedReferencePath = path.join(trustedParent, 'copy-after-persist.jpg');
  const copiedDestinationPath = path.join(trustedProgress, 'copy-after-persist.jpg');
  fs.writeFileSync(copiedReferencePath, 'persisted-version-file');
  writeLogImplementation = (level, message) => {
    if (level === 'info' && message === 'Version batch committed') throw new Error('injected log failure after persistence');
  };
  const batchCommittedDespiteLogFailure = await batchCommit({}, workspaceRoot, 'active', 'Project', {
    folderA: trustedParent,
    folderB: trustedProgress,
    copyMissingReferences: ['copy-after-persist.jpg'],
    matches: [],
  });
  writeLogImplementation = () => undefined;
  assert.strictEqual(batchCommittedDespiteLogFailure.success, true, 'post-persistence logging must not turn a committed batch into failure');
  assert.strictEqual(fs.readFileSync(copiedDestinationPath, 'utf8'), 'persisted-version-file', 'post-persistence logging must not delete committed copies');

  const originalCommitBatchCompare = versionService.commitBatchCompare;
  const guardedReferencePath = path.join(trustedParent, 'post-persist-guard.jpg');
  const guardedDestinationPath = path.join(trustedProgress, 'post-persist-guard.jpg');
  fs.writeFileSync(guardedReferencePath, 'guarded-persisted-file');
  versionService.commitBatchCompare = async () => new Proxy({ success: true }, {
    get: (target, property) => {
      if (property === 'batch') throw new Error('injected post-persist metadata failure');
      return Reflect.get(target, property);
    },
  });
  const failedAfterPersistence = await batchCommit({}, workspaceRoot, 'active', 'Project', {
    folderA: trustedParent,
    folderB: trustedProgress,
    copyMissingReferences: ['post-persist-guard.jpg'],
    matches: [],
  });
  versionService.commitBatchCompare = originalCommitBatchCompare;
  assert.strictEqual(failedAfterPersistence.success, false, 'a post-persistence metadata failure must be reported');
  assert.match(failedAfterPersistence.error, /post-persist metadata failure/);
  assert.strictEqual(fs.readFileSync(guardedDestinationPath, 'utf8'), 'guarded-persisted-file', 'post-persistence catch must not roll back committed copies');

  const originalGetTrackingCommitPlan = versionService.getTrackingCommitPlan;
  let releaseCommitPlan;
  const commitPlanGate = new Promise(resolve => { releaseCommitPlan = resolve; });
  let concurrentPlanCalls = 0;
  versionService.getTrackingCommitPlan = async (...args) => {
    concurrentPlanCalls += 1;
    await commitPlanGate;
    return originalGetTrackingCommitPlan(...args);
  };
  const concurrentSessionId = '66666666-6666-4666-8666-666666666666';
  const firstConcurrentCommit = commit({}, workspaceRoot, { sessionId: concurrentSessionId });
  await Promise.resolve();
  const secondConcurrentCommit = commit({}, workspaceRoot, { sessionId: concurrentSessionId });
  const releaseDuringCommit = await release({}, workspaceRoot, { sessionId: concurrentSessionId });
  assert.strictEqual(releaseDuringCommit.success, false, 'an in-flight commit session must not be released');
  assert.match(releaseDuringCommit.error, /正在提交/);
  releaseCommitPlan();
  const concurrentResults = await Promise.all([firstConcurrentCommit, secondConcurrentCommit]);
  assert(concurrentResults.every(result => result.success), 'duplicate commit callers must share the successful result');
  assert.strictEqual(concurrentPlanCalls, 1, 'duplicate commit requests for one session must execute one commit plan');
  versionService.getTrackingCommitPlan = originalGetTrackingCommitPlan;

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

  const mainBranchMedia = handlers.get('workspace-progress-main-branch-media');
  versionService.getMainBranchMedia = async (_root, request) => {
    calls.mainBranchRequest = request;
    if (request.progressId === 'broll-or-orphan') throw new Error('main_branch_progress_invalid');
    return { success: true, progressId: request.progressId, entries: [], branchProgressIds: [request.progressId] };
  };
  const invalidMainBranch = await mainBranchMedia({}, workspaceRoot, {
    progressId: 'broll-or-orphan', nodeRole: 'original', folderPath: 'C:\\outside',
  });
  assert.strictEqual(invalidMainBranch.success, false);
  assert.match(invalidMainBranch.error, /main_branch_progress_invalid/);
  assert.deepStrictEqual(calls.mainBranchRequest, { progressId: 'broll-or-orphan' }, 'main-branch IPC must forward only stable media/progress IDs');
  const validMainBranch = await mainBranchMedia({}, workspaceRoot, { progressId: 'progress-node-id', photoId: 'photo-id', nodeRole: 'broll' });
  assert.strictEqual(validMainBranch.success, true);
  assert.deepStrictEqual(calls.mainBranchRequest, { progressId: 'progress-node-id', photoId: 'photo-id' });

  const register = handlers.get('workspace-progress-register');
  const externalProgressPath = path.join(workspaceRoot, 'external-progress');
  const externalShortcutPath = path.join(workspaceRoot, 'Project', 'external-progress.lnk');
  fs.mkdirSync(externalProgressPath, { recursive: true });
  projectVirtualPaths.createManagedExternalLink(externalShortcutPath, { target: externalProgressPath, kind: 'folder', displayName: 'external-progress' });
  let externalRegistrationRequest;
  const originalParentNode = {
    id: 'parent-progress-id', nodeRole: 'original', mediaKind: 'image', folderMissing: false,
    versionKey: 'source', displayName: 'Source', folderPath: trustedParent,
  };
  versionService.listProgress = async () => ({ success: true, progressFolders: [originalParentNode] });
  versionService.registerProgress = async (_root, request) => {
    externalRegistrationRequest = request;
    return { success: true, progressFolder: { id: 'external-node', ...request } };
  };
  const injectedRegistration = await register({}, workspaceRoot, 'active', 'Project', {
    relativePath: 'external-progress.lnk', mediaKind: 'image', versionKey: '1',
    displayName: 'external-progress', parentProgressId: originalParentNode.id,
    nodeRole: 'original', folderPath: 'C:\\outside', trackingEnabled: true,
  });
  assert.strictEqual(injectedRegistration.success, false, 'renderer role and absolute-path injection must be rejected');
  assert.strictEqual(externalRegistrationRequest, undefined);
  const missingParentRegistration = await register({}, workspaceRoot, 'active', 'Project', {
    relativePath: 'external-progress.lnk', mediaKind: 'image', versionKey: '1',
    displayName: 'external-progress', trackingEnabled: true,
  });
  assert.strictEqual(missingParentRegistration.success, false);
  assert.match(missingParentRegistration.error, /progress_parent_required/);
  assert.strictEqual(externalRegistrationRequest, undefined, 'missing-parent progress must fail before any repository write');
  const externalRegistration = await register({}, workspaceRoot, 'active', 'Project', {
    relativePath: 'external-progress.lnk', mediaKind: 'image', versionKey: '1',
    displayName: 'external-progress', parentProgressId: originalParentNode.id, trackingEnabled: true,
  });
  assert.strictEqual(externalRegistration.success, true, externalRegistration.error);
  assert.strictEqual(externalRegistration.relativePath, 'external-progress.lnk');
  assert.strictEqual(externalRegistrationRequest.folderPath, externalProgressPath, 'external progress tracking must persist the shortcut target path');
  assert.strictEqual(externalRegistrationRequest.externalLinkRelativePath, 'external-progress.lnk');
  assert.strictEqual(externalRegistrationRequest.nodeRole, 'progress');
  assert.strictEqual(externalRegistrationRequest.relationKind, 'main', 'main process must derive the only legal progress role/relation');

  const updateProgress = handlers.get('workspace-progress-update');
  let treeUpdateRequest;
  versionService.beginProgressTreeUpdate = async () => ({ success: true, mutationToken: 'tree-mutation-token' });
  versionService.finishProgressTreeUpdate = async () => ({ success: true });
  versionService.listProgress = async () => ({
    success: true,
    progressFolders: [originalParentNode, {
      id: 'external-node', nodeRole: 'progress', relationKind: 'main', mediaKind: 'image',
      versionKey: '1', displayName: 'external-progress', folderPath: externalProgressPath,
      externalLinkRelativePath: 'external-progress.lnk', trackingEnabled: false,
      trackingState: 'disabled', parentProgressId: originalParentNode.id,
    }],
  });
  versionService.updateProgressTree = async (_root, request) => {
    treeUpdateRequest = request;
    return { success: true, progressFolder: { id: 'external-node' }, progressFolders: [] };
  };
  const externalUpdate = await updateProgress({}, workspaceRoot, 'active', 'Project', {
    progressId: 'external-node', mediaKind: 'image', versionKey: '2',
    displayName: 'renamed-external-progress', parentProgressId: originalParentNode.id, preserveFolderPath: false,
  });
  assert.strictEqual(externalUpdate.success, true, externalUpdate.error);
  assert.strictEqual(treeUpdateRequest.mutationToken, 'tree-mutation-token');
  assert.strictEqual(treeUpdateRequest.updates.length, 1, 'semantic updates must mutate only the selected version node');
  assert.strictEqual('folderPath' in treeUpdateRequest.updates[0], false, 'semantic updates must never submit a physical path');
  assert.strictEqual('displayName' in treeUpdateRequest.updates[0], false, 'display names are directory caches and not version-tree addressing inputs');
  assert.strictEqual(fs.existsSync(externalProgressPath), true, 'editing external progress metadata must not move the external directory');
  const treeTask = calls.taskDefinitions.find(definition => definition.type === 'version-tree-update');
  assert(treeTask && treeTask.resourceAccess === 'write' && treeTask.resources[0] === path.join(workspaceRoot, 'Project'), 'whole-tree edits must reserve the project path for writes');

  const failedNested = path.join(workspaceRoot, 'Project', 'nested', 'Rollback me');
  fs.mkdirSync(failedNested, { recursive: true });
  versionService.registerProgress = async () => { throw new Error('simulated database failure'); };
  const failedRegistration = await register({}, workspaceRoot, 'active', 'Project', {
    relativePath: path.join('nested', 'Rollback me'), mediaKind: 'image', versionKey: 'arbitrary-child',
    displayName: 'Rollback me',
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
    displayName: 'Move me',
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

  const renameProgressFolder = handlers.get('workspace-progress-folder-rename');
  const localFolder = path.join(workspaceRoot, 'Project', 'Move me');
  const localFolderId = 'folder-id-move-me';
  versionService.listProgress = async () => ({ success: true, progressFolders: [{
    id: 'moved-node', nodeRole: 'progress', mediaKind: 'image', displayName: 'Move me',
    folderPath: localFolder, folderId: localFolderId, trackingState: 'ready',
  }] });
  versionService.renameProgressFolder = async (_root, request) => {
    calls.renameProgressRequest = request;
    return { success: true, progressId: request.progressId, oldRelativePath: 'Move me', newRelativePath: request.newName };
  };
  calls.failCatalogRefresh = true; const renamedProgress = await renameProgressFolder({}, workspaceRoot, 'active', 'Project', {
    progressId: 'moved-node', expectedFolderId: localFolderId, expectedRelativePath: 'Move me', newName: '客户自由命名',
  }); calls.failCatalogRefresh = false;
  assert.strictEqual(renamedProgress.success, true, renamedProgress.error);
  assert.strictEqual(renamedProgress.warnings[0].code, 'WORKSPACE_CATALOG_REFRESH_FAILED', 'a post-commit catalog refresh failure is a degraded warning, not a false transaction failure');
  const { reservedProjectFolderNames, ...renameProgressRequest } = calls.renameProgressRequest;
  assert(Array.isArray(reservedProjectFolderNames) && reservedProjectFolderNames.includes('raw'), 'Host must inject its current generic relocation policy');
  assert.deepStrictEqual(renameProgressRequest, {
    projectName: 'Project', progressId: 'moved-node', expectedFolderId: localFolderId,
    expectedRelativePath: 'Move me', newName: '客户自由命名', mutationToken: 'tree-mutation-token',
  });
  assert(calls.suppressedWatchPaths.includes(localFolder), 'rename must suppress the old watcher path while committing');
  assert(calls.releasedWatchPaths.includes(localFolder), 'rename must refresh/release watcher suppression after committing');
  const staleRename = await renameProgressFolder({}, workspaceRoot, 'active', 'Project', {
    progressId: 'moved-node', expectedFolderId: 'stale-folder-id', expectedRelativePath: 'Move me', newName: '不会提交',
  });
  assert.strictEqual(staleRename.success, false);
  assert.match(staleRename.error, /identity_mismatch/);

  const externalFolderId = 'external-folder-id';
  let externalListedRoute = 'external-progress.lnk';
  versionService.listProgress = async () => ({ success: true, progressFolders: [{
    id: 'external-node', nodeRole: 'progress', mediaKind: 'image', displayName: 'external-progress',
    folderPath: externalProgressPath, folderId: externalFolderId, externalLinkRelativePath: externalListedRoute,
    trackingState: 'ready',
  }] });
  const externalRouteRequests = [];
  versionService.renameExternalProgressLinkRoute = async (_root, request) => {
    externalRouteRequests.push(request);
    if (request.preflight) return { success: true, operationId: 'external-operation', affectedProgressIds: ['external-node'] };
    fs.renameSync(request.oldPath, request.newPath);
    externalListedRoute = request.newRelativePath;
    return {
      success: true, oldRelativePath: request.oldRelativePath, newRelativePath: request.newRelativePath,
      progressFolder: {
        id: 'external-node', nodeRole: 'progress', mediaKind: 'image', displayName: '客户终稿',
        folderPath: externalProgressPath, folderId: externalFolderId, externalLinkRelativePath: request.newRelativePath,
      },
    };
  };
  const renamedExternal = await renameProgressFolder({}, workspaceRoot, 'active', 'Project', {
    progressId: 'external-node', expectedFolderId: externalFolderId,
    expectedRelativePath: 'external-progress.lnk', newName: '客户终稿',
  });
  assert.strictEqual(renamedExternal.success, true, renamedExternal.error);
  assert.strictEqual(fs.existsSync(externalShortcutPath), false, 'the old project shortcut alias must be removed');
  assert.strictEqual(fs.existsSync(path.join(workspaceRoot, 'Project', '客户终稿.lnk')), true, 'the renamed project shortcut alias must exist');
  assert.strictEqual(fs.existsSync(externalProgressPath), true, 'renaming an external version alias must not rename its physical target');
  assert.deepStrictEqual(externalRouteRequests.map(request => ({
    oldRelativePath: request.oldRelativePath, newRelativePath: request.newRelativePath, preflight: request.preflight === true,
  })), [
    { oldRelativePath: 'external-progress.lnk', newRelativePath: '客户终稿.lnk', preflight: true },
    { oldRelativePath: 'external-progress.lnk', newRelativePath: '客户终稿.lnk', preflight: false },
  ]);
  const repeatedExternal = await renameProgressFolder({}, workspaceRoot, 'active', 'Project', {
    progressId: 'external-node', expectedFolderId: externalFolderId,
    expectedRelativePath: 'external-progress.lnk', newName: '客户终稿',
  });
  assert.strictEqual(repeatedExternal.success, true); assert.strictEqual(repeatedExternal.idempotent, true, 'a retry after startup recovery recognizes the already committed route and does not rename again');
  assert.strictEqual(calls.externalWatcherRefreshes, 2, 'normal commit and recovered retry both rebuild watcher routes');

  console.log('version tracking V2 IPC tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});
