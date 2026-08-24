const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { createAdvancedVideoService } = require('../electron/services/advanced-video-service.cjs');

const makeChild = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinLines = [];
  child.stdin.on('data', chunk => child.stdinLines.push(...chunk.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)));
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-video-screenshot-publication-'));
  try {
    const source = path.join(root, 'camera.mov');
    fs.writeFileSync(source, 'video');
    const sender = new EventEmitter();
    sender.id = 31;
    sender.isDestroyed = () => false;
    sender.send = () => undefined;
    const nativeHandle = Buffer.alloc(8);
    nativeHandle.writeBigUInt64LE(42n);
    const children = [];
    let sequence = 0;
    const service = createAdvancedVideoService({
      BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
      crypto: { randomUUID: () => `capture-${++sequence}` },
      mediaService: { authorizeInput: async value => path.resolve(value) },
      path,
      pluginService: { resolveRunConfigAsync: async () => ({ command: 'C:\\component\\advanced-video-decoder.exe', args: [] }) },
      spawn: () => {
        const child = makeChild();
        children.push(child);
        process.nextTick(() => child.stdout.write('{"type":"ready"}\n'));
        return child;
      },
      screenshotTimeoutMs: 140,
      screenshotProbeMs: 10,
      writeLog: () => undefined,
    });
    const session = await service.start({ sender }, source, {}, 'player-focused', 'request-focused');
    const child = children[0];
    const screenshotCommand = () => [...child.stdinLines].reverse().find(item => item.command === 'screenshot');
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

    const successful = service.screenshot({ sender }, session.sessionId);
    const successCommand = screenshotCommand();
    assert.match(path.basename(successCommand.path), /^\.camera\.capture-2\.photoflow-transcode-screenshot\.png$/);
    fs.writeFileSync(successCommand.path, Buffer.concat([signature, Buffer.from('partial')]));
    child.stdout.write(`${JSON.stringify({ type: 'screenshot-result', requestId: successCommand.requestId, success: true, path: successCommand.path })}\n`);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(fs.readdirSync(root).some(name => name.startsWith('camera_截图_')), false);
    fs.appendFileSync(successCommand.path, iend);
    const result = await successful;
    assert.equal(fs.existsSync(result.path), true);
    assert.equal(fs.existsSync(successCommand.path), false);

    const publicCountBeforeIncomplete = fs.readdirSync(root).filter(name => name.startsWith('camera_截图_')).length;
    const incomplete = service.screenshot({ sender }, session.sessionId);
    const incompleteCommand = screenshotCommand();
    fs.writeFileSync(incompleteCommand.path, Buffer.concat([signature, Buffer.from('never completed')]));
    child.stdout.write(`${JSON.stringify({ type: 'screenshot-result', requestId: incompleteCommand.requestId, success: true, path: incompleteCommand.path })}\n`);
    const incompleteKeepAlive = setTimeout(() => undefined, 250);
    await assert.rejects(incomplete, /超时|未完整写入/);
    clearTimeout(incompleteKeepAlive);
    assert.equal(fs.existsSync(incompleteCommand.path), false, 'success followed by an incomplete PNG must clean the temporary file on timeout');
    assert.equal(
      fs.readdirSync(root).filter(name => name.startsWith('camera_截图_')).length,
      publicCountBeforeIncomplete,
      'an incomplete component success must never publish a public screenshot',
    );

    const failed = service.screenshot({ sender }, session.sessionId);
    const failedCommand = screenshotCommand();
    fs.writeFileSync(failedCommand.path, 'partial');
    child.stdout.write(`${JSON.stringify({ type: 'screenshot-result', requestId: failedCommand.requestId, success: false, error: 'capture failed' })}\n`);
    await assert.rejects(failed, /capture failed/);
    assert.equal(fs.existsSync(failedCommand.path), false);

    const timedOut = service.screenshot({ sender }, session.sessionId);
    const timedOutCommand = screenshotCommand();
    fs.writeFileSync(timedOutCommand.path, 'partial');
    const keepAlive = setTimeout(() => undefined, 250);
    await assert.rejects(timedOut, /超时/);
    clearTimeout(keepAlive);
    assert.equal(fs.existsSync(timedOutCommand.path), false);

    const stopped = service.screenshot({ sender }, session.sessionId);
    const stoppedCommand = screenshotCommand();
    fs.writeFileSync(stoppedCommand.path, 'partial');
    service.stop(session.sessionId, sender.id);
    await assert.rejects(stopped, /停止/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.existsSync(stoppedCommand.path), false);

    let releaseRename;
    let markRenameStarted;
    const renameStarted = new Promise(resolve => { markRenameStarted = resolve; });
    const renameGate = new Promise(resolve => { releaseRename = resolve; });
    const raceFileSystem = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (...args) => {
          markRenameStarted();
          await renameGate;
          return fs.promises.rename(...args);
        },
      },
    };
    const raceChildren = [];
    let raceSequence = 0;
    const raceService = createAdvancedVideoService({
      BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => nativeHandle }) },
      crypto: { randomUUID: () => `race-${++raceSequence}` },
      mediaService: { authorizeInput: async value => path.resolve(value) },
      path,
      pluginService: { resolveRunConfigAsync: async () => ({ command: 'C:\\component\\advanced-video-decoder.exe', args: [] }) },
      spawn: () => {
        const raceChild = makeChild();
        raceChildren.push(raceChild);
        process.nextTick(() => raceChild.stdout.write('{"type":"ready"}\n'));
        return raceChild;
      },
      fileSystem: raceFileSystem,
      screenshotTimeoutMs: 50,
      screenshotProbeMs: 5,
      writeLog: () => undefined,
    });
    const raceSession = await raceService.start({ sender }, source, {}, 'player-race', 'request-race');
    const raceCapture = raceService.screenshot({ sender }, raceSession.sessionId);
    const raceCommand = [...raceChildren[0].stdinLines].reverse().find(item => item.command === 'screenshot');
    fs.writeFileSync(raceCommand.path, Buffer.concat([signature, iend]));
    raceChildren[0].stdout.write(`${JSON.stringify({ type: 'screenshot-result', requestId: raceCommand.requestId, success: true, path: raceCommand.path })}\n`);
    await renameStarted;
    await new Promise(resolve => setTimeout(resolve, 80));
    raceService.stop(raceSession.sessionId, sender.id);
    releaseRename();
    const raceResult = await raceCapture;
    assert.equal(fs.existsSync(raceResult.path), true, 'a rename that crossed the commit boundary must resolve success even if timeout and stop occur while it is pending');
    assert.equal(fs.existsSync(raceCommand.path), false);
    console.log('advanced video screenshot publication tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
