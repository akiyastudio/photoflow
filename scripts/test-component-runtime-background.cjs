const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { createEventBus } = require('../electron/services/event-bus.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { createComponentRuntimeExecutionService } = require('../electron/services/component-runtime-execution-service.cjs');
const { registerComponentProjectCapabilities } = require('../electron/services/component-project-capabilities.cjs');

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-runtime-background-'));
  const eventBus = createEventBus();
  const backgroundTasks = createBackgroundTaskService({ eventBus });
  const broker = new ComponentCapabilityBroker();
  const componentRoot = path.resolve(__dirname, '..', 'extensions', 'video-tools');
  const manifest = JSON.parse(fs.readFileSync(path.join(componentRoot, 'component.json'), 'utf8'));
  const descriptor = { componentId: manifest.id, service: manifest.componentHost.service };
  const events = [], deltas = [], workers = [], graphWrites = [], hostNotifications = [];
  const context = {
    surface: 'component.sidePanel', workspacePath: root, projectId: 'project-1', projectName: 'Project',
    projectStatus: 'active', sourcePageId: 'page-1', contributionId: 'transcode', scopeRelativePath: '',
    emitComponentEvent: (topic, payload) => events.push({ topic, ...payload }),
  };
  eventBus.on('background-task:changed', delta => deltas.push(delta));
  fs.writeFileSync(path.join(root, 'input.mp4'), 'synthetic input');
  const inputTokens = registerComponentProjectCapabilities({
    broker, backgroundTasks, path, fs, crypto, IMAGE_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(['.mp4']),
    ensureWorkspace: value => value, getProjectPath: () => root, getWorkspaceDataRoot: () => path.join(root, '.data'),
    getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }),
  });
  const runtime = createComponentRuntimeExecutionService({
    broker, backgroundTasks, path, fs, crypto, inputTokens,
    ensureWorkspace: value => value, getProjectPath: () => root, getWorkspaceDataRoot: () => path.join(root, '.data'),
    getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }),
    versionService: {
      listProgress: async () => ({ progressFolders: [{ id: 'source-progress', folderPath: path.join(root, 'mov'), nodeRole: 'original', mediaKind: 'video' }] }),
      adoptMediaFolder: async (_root, payload) => {
        assert.equal(backgroundTasks.list().some(task => task.state === 'running'), true, 'graph registration is part of the running task');
        graphWrites.push(payload);
        return { success: true, progressFolder: { id: 'derived-progress' }, edge: { id: 'derived-edge' } };
      },
    },
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, payload) => hostNotifications.push({ channel, payload }) } },
    pluginService: { runJsonForComponentCapability: (_id, capability, args, _timeout, report, signal) => new Promise((resolve, reject) => {
      assert.equal(capability, 'media.video.processing.cli');
      assert.equal(args[0], 'ffmpeg_transcode');
      workers.push({ resolve, reject, report, signal, input: args[1], pauseFile: args[args.indexOf('--pause_file') + 1] });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' })), { once: true });
    }) },
  });
  const child = spawn(process.execPath, [path.join(componentRoot, 'service.cjs')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let ready = false, sequence = 0;
  const send = frame => child.stdin.write(`${JSON.stringify(frame)}\n`);
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'ready') { ready = true; return; }
    if (frame.type === 'capability') {
      void Promise.resolve().then(() => broker.invoke(descriptor, frame.method, frame.payload, context)).then(
        result => send({ type: 'capability-response', id: frame.id, ok: true, result }),
        error => send({ type: 'capability-response', id: frame.id, ok: false, error: error.message, errorCode: error.code }),
      );
    } else if (frame.type === 'response') {
      const request = pending.get(frame.id); pending.delete(frame.id);
      if (frame.ok) request?.resolve(frame.result); else request?.reject(Object.assign(new Error(frame.error), { code: frame.errorCode }));
    }
  });
  const rpc = (method, payload) => new Promise((resolve, reject) => {
    const id = String(++sequence); pending.set(id, { resolve, reject });
    send({ type: 'request', id, method, payload, context: { componentId: 'video-tools', projectId: 'project-1' } });
  });
  const transcode = (key, tokens = []) => rpc('video-tools.transcode.v1', { idempotencyKey: key, relativePaths: tokens.length ? [] : ['input.mp4'], inputTokens: tokens, settings: {}, outputMode: 'new' });
  try {
    await waitFor(() => ready, 'service ready');
    const dropped = await inputTokens.grantDroppedInputs([path.join(root, 'input.mp4')], descriptor, context);
    const completed = transcode('complete', [dropped.inputs[0].token]);
    await waitFor(() => workers.length === 1, 'host task creation');
    const task = backgroundTasks.list()[0];
    assert.equal(task.state, 'running');
    assert.equal(task.title, '视频转码');
    assert.equal(task.notificationPolicy, 'progress-and-result');
    assert.equal(task.taskCenterPolicy, 'always');
    assert.equal(task.metadata.presentationOwnerPageId, 'page-1');
    assert.equal(task.metadata.presentationPanelKind, 'component:video-tools:transcode');
    assert.notEqual(workers[0].input, path.join(root, 'input.mp4'), 'external input is an owned snapshot');
    await inputTokens.clearComponent('video-tools', { preserveReservedInputs: true });
    assert.equal(fs.existsSync(workers[0].input), true, 'closing the panel retains the running task input');
    assert.equal(workers[0].signal.aborted, false);
    workers[0].report({ type: 'progress', progress: 35, message: '正在转码' });
    assert.equal(backgroundTasks.get(task.id).progress, 35);
    assert(deltas.some(delta => delta.upserts.some(item => item.id === task.id && item.progress === 35)), 'host renderer receives live progress');
    assert.equal(backgroundTasks.pause(task.id), true);
    await waitFor(() => fs.existsSync(workers[0].pauseFile) && backgroundTasks.get(task.id).state === 'paused', 'host pause reaches worker');
    backgroundTasks.continuePaused(task.id);
    await waitFor(() => !fs.existsSync(workers[0].pauseFile) && backgroundTasks.get(task.id).state === 'running', 'host resume reaches worker');
    const restored = await rpc('video-tools.operation.current.v1', { processAction: 'video.transcode' });
    assert.equal(restored.operation.task.id, task.id, 'reopened panel restores the host task');
    assert.equal(restored.operation.task.progress, 35);
    workers[0].resolve({ type: 'success', report: [{ output: 'synthetic-output.mp4' }], failedCount: 0 });
    assert.equal((await completed).report.length, 1);
    assert.equal(fs.existsSync(workers[0].input), false, 'completed tasks release their input snapshots');
    assert.equal(backgroundTasks.get(task.id).state, 'completed');
    assert(events.some(event => event.eventType === 'complete' && event.operationId === task.id));

    const cancelled = transcode('cancel');
    const cancelledResult = assert.rejects(cancelled, error => error.code === 'TASK_CANCELLED');
    await waitFor(() => workers.length === 2, 'second transcode');
    const current = backgroundTasks.list().find(item => item.state === 'running');
    backgroundTasks.cancel(current.id);
    await cancelledResult;
    assert.equal(backgroundTasks.get(current.id).state, 'cancelled');
    assert(events.some(event => event.eventType === 'cancelled' && event.operationId === current.id));

    const failed = transcode('fail');
    const failedResult = assert.rejects(failed, /encoder failed/);
    await waitFor(() => workers.length === 3, 'third transcode');
    workers[2].reject(new Error('encoder failed'));
    await failedResult;
    assert.equal(backgroundTasks.list().find(item => item.state === 'failed').error, 'encoder failed');
    assert(events.some(event => event.eventType === 'failed'));

    const disabled = transcode('disable');
    const disabledResult = assert.rejects(disabled, error => error.code === 'TASK_CANCELLED');
    await waitFor(() => workers.length === 4, 'fourth transcode');
    runtime.clearComponent('video-tools');
    await disabledResult;

    const sourceFolder = path.join(root, 'mov'), outputFolder = path.join(root, 'custom-output');
    fs.mkdirSync(sourceFolder); fs.mkdirSync(outputFolder);
    const folderTranscode = rpc('video-tools.transcode.v1', { idempotencyKey: 'folder-output', relativePaths: ['mov'], settings: {}, outputMode: 'new' });
    await waitFor(() => workers.length === 5, 'folder transcode');
    workers[4].resolve({ type: 'success', outputs: [path.join(outputFolder, 'video.mp4')], report: [], folderOutputs: [{ sourceFolder, outputFolder }] });
    const folderResult = await folderTranscode;
    assert.equal(graphWrites.length, 1);
    assert.equal(graphWrites[0].sourceProgressId, 'source-progress');
    assert.equal(graphWrites[0].mode, 'transcode');
    assert.equal(folderResult.projectArtifacts.linked[0].targetProgressId, 'derived-progress');
    assert.equal(hostNotifications[0].channel, 'workspace-files-changed', 'host version tree is notified after graph registration');
    const deniedDescriptor = { ...descriptor, service: { ...descriptor.service, permissions: descriptor.service.permissions.filter(value => value !== 'project.progress') } };
    await assert.rejects(broker.invoke(deniedDescriptor, 'component.runtime.execute', { action: 'execute', runtimeCapability: 'media.video.processing.cli', arguments: ['ffmpeg_transcode'], projectArtifacts: { mode: 'transcode', mediaKind: 'video' } }, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED');
    assert.equal(workers.length, 5, 'missing progress permission is rejected before starting a worker');
    console.log('Video transcode service → host background tasks: progress, panel restoration, pause, resume, cancel, failure and disable passed.');
  } finally {
    backgroundTasks.stop();
    child.stdin.end();
    if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
    lines.close();
    eventBus.clear();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
