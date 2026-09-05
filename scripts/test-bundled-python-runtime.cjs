const assert = require('assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const os = require('os');
const path = require('path');
const { createBundledPythonRuntime } = require('../electron/services/bundled-python-runtime.cjs');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

const launched = [];
let pluginService;
const runtime = createBundledPythonRuntime({
  app: { isPackaged: false },
  projectRoot: path.resolve('test-project'),
  processSupervisor: {
    launch: options => {
      const child = new FakeChild();
      launched.push({ options, child });
      return { child };
    },
  },
  getPluginService: () => pluginService,
  getDevelopmentPython: () => 'development-python',
});

assert.deepStrictEqual(runtime.getRunConfig('classify.py', ['--source', 'photo.jpg']), {
  command: 'development-python',
  args: ['-u', path.resolve('test-project', 'python', 'classify.py'), '--source', 'photo.jpg'],
});
assert.throws(() => runtime.getRunConfig('unknown.py', []), /Unknown bundled Python tool/);
assert.throws(() => runtime.getRunConfig('classify.py', ['bad\0argument']), /Invalid bundled Python tool arguments/);
assert.throws(() => runtime.getRunConfig('cut_video.py', []), error => error.code === 'PLUGIN_MISSING');

pluginService = {
  resolveRunConfig: (componentId, args) => ({ command: `${componentId}.exe`, args }),
};
assert.deepStrictEqual(runtime.getRunConfig('cut_video.py', ['input.mov']), {
  command: 'video-tools.exe',
  args: ['cut_video', 'input.mov'],
});

const frameRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-bundled-python-frame-runtime-'));
try {
  const folderA = path.join(frameRuntimeRoot, 'a');
  const folderB = path.join(frameRuntimeRoot, 'b');
  fs.mkdirSync(folderA);
  fs.mkdirSync(folderB);
  fs.writeFileSync(path.join(folderA, 'reference.mp4'), 'video');
  const capabilityCalls = [];
  pluginService = {
    resolveRunConfigForCapability: (capability, args) => {
      capabilityCalls.push({ capability, args });
      return { command: 'video-tools-worker.exe', args: ['worker-entry', ...args] };
    },
  };
  const run = runtime.getRunConfig('rename.py', ['--folder_a', folderA, '--folder_b', folderB, '--preview']);
  assert.equal(run.command, 'development-python');
  assert.deepStrictEqual(run.args.slice(-4), [
    '--preview',
    '--video_tools_command',
    'video-tools-worker.exe',
    '--video_tools_arg=worker-entry',
  ]);
  assert.deepStrictEqual(capabilityCalls, [{ capability: 'media.video.processing.cli', args: [] }]);
  assert(!run.args.includes('--video_tools_arg=ffmpeg_transcode'), 'frame bridge must not be routed through the ffmpeg_transcode worker action');
  assert.equal(run.args.includes('--video_tools_command'), true);
} finally {
  fs.rmSync(frameRuntimeRoot, { recursive: true, force: true });
}

const packagedRuntime = createBundledPythonRuntime({
  app: { isPackaged: true },
  projectRoot: path.resolve('unused-project'),
  processSupervisor: { launch: () => { throw new Error('not used'); } },
  getPluginService: () => pluginService,
  getDevelopmentPython: () => { throw new Error('not used'); },
  platform: 'win32',
  resourcesPath: path.resolve('packaged-resources'),
});
assert.deepStrictEqual(packagedRuntime.getRunConfig('thumbnail_db', ['--server']), {
  command: path.resolve('packaged-resources', 'python', 'PhotoFlowImportWorker', 'PhotoFlowImportWorker.exe'),
  args: ['thumbnail_db', '--server'],
});
assert.deepStrictEqual(packagedRuntime.getRunConfig('research.py', ['topic']), {
  command: path.resolve('packaged-resources', 'python', 'inspiration-tools', 'inspiration-tools.exe'),
  args: ['research', 'topic'],
});

const main = async () => {
  const received = [];
  const success = runtime.runPythonEventAction('classify.py', [], 1000, undefined, event => received.push(event));
  const first = launched.at(-1);
  first.child.stdout.write('worker banner\n{"type":"progress","value":1}\n{"type":"success","value":2}');
  first.child.emit('close', 0);
  assert.deepStrictEqual(await success, [
    { type: 'progress', value: 1 },
    { type: 'success', value: 2 },
  ]);
  assert.deepStrictEqual(received, [
    { type: 'progress', value: 1 },
    { type: 'success', value: 2 },
  ]);
  assert.strictEqual(first.options.id, 'python:event-job:1');
  assert.strictEqual(first.options.kind, 'python-job');
  assert.strictEqual(first.options.ephemeral, true);
  assert.deepStrictEqual(first.options.options.stdio, ['ignore', 'pipe', 'pipe']);

  const failed = runtime.runPythonEventAction('classify.py', [], 1000);
  const second = launched.at(-1);
  second.child.stdout.end('{"type":"error","message":"worker failed"}\n');
  second.child.emit('close', 7);
  await assert.rejects(failed, /worker failed/);

  const controller = new AbortController();
  const cancelled = runtime.runPythonEventAction('classify.py', [], 1000, controller.signal);
  const third = launched.at(-1);
  controller.abort();
  await assert.rejects(cancelled, error => error.code === 'TASK_CANCELLED' && error.message === '任务已取消');
  assert.strictEqual(third.child.killed, true);
  assert.strictEqual(third.options.id, 'python:event-job:3');

  const jsonResult = runtime.runPythonJsonAction('classify.py', [], 1000);
  const fourth = launched.at(-1);
  fourth.child.stdout.write('{"type":"success","value":4}\n');
  fourth.child.emit('close', 0);
  assert.deepStrictEqual(await jsonResult, { type: 'success', value: 4 });
  assert.strictEqual(fourth.options.id, 'python:json-job:4');

  console.log('Bundled Python runtime regression tests passed');
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
