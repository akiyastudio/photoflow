const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');
const { createMediaInputSessionService } = require('../electron/services/media-input-session-service.cjs');
const { createNativeVideoSurfaceService } = require('../electron/services/native-video-surface-service.cjs');

const run = async () => {
  const inputs = createMediaInputSessionService({ mediaService: { authorizeInput: async value => path.resolve(value) } });
  await inputs.prepare({ filePath: 'C:/project/clip.mp4', backendId: 'fixture:decoder', sessionId: 'session-input' });
  inputs.bindProcess({ sessionId: 'session-input', backendId: 'fixture:decoder', processId: 321 });
  assert.equal(inputs.resolve({ sessionId: 'session-input', backendId: 'fixture:decoder', processId: 321 }), path.resolve('C:/project/clip.mp4'));
  assert.throws(() => inputs.resolve({ sessionId: 'session-input', backendId: 'other', processId: 321 }), /不属于/);
  assert.throws(() => inputs.resolve({ sessionId: 'session-input', backendId: 'fixture:decoder', processId: 999 }), /不属于/);
  assert.equal(inputs.revokeProcess(321), 1);
  assert.throws(() => inputs.resolve({ sessionId: 'session-input', backendId: 'fixture:decoder', processId: 321 }), /不存在/);

  const launches = [];
  const spawn = (_command, args) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 800; child.killed = false; child.kill = () => { child.killed = true; };
    child.commands = []; child.stdin.on('data', chunk => child.commands.push(...chunk.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)));
    launches.push({ args, child });
    process.nextTick(() => child.stdout.write(`${JSON.stringify({ type: 'ready', sessionId: 'surface-session' })}\n`));
    return child;
  };
  const surfaceHost = createNativeVideoSurfaceService({ app: { isPackaged: false }, path, spawn, writeLog() {}, startupTimeoutMs: 100 });
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(12345n);
  const controller = await surfaceHost.attach({ ownerWindow: { isDestroyed: () => false, getNativeWindowHandle: () => handle }, componentProcess: { pid: 777 }, surfaceHandle: '45678', sessionId: 'surface-session' });
  assert.deepEqual(launches[0].args, ['--parent-hwnd', '12345', '--child-hwnd', '45678', '--expected-pid', '777', '--session-id', 'surface-session']);
  controller.setBounds({ x: 1, y: 2, width: 300, height: 200, visible: true });
  assert.equal(launches[0].child.commands[0].command, 'bounds');
  controller.close();
  assert.equal(launches[0].child.commands.at(-1).command, 'close');
  await assert.rejects(surfaceHost.attach({ ownerWindow: { isDestroyed: () => false, getNativeWindowHandle: () => handle }, componentProcess: { pid: 777 }, surfaceHandle: 'not-a-handle', sessionId: 'surface-session' }), /声明无效/);

  const nativeHost = fs.readFileSync(path.join(__dirname, '..', 'electron/native/VideoSurfaceHost.cs'), 'utf8');
  const decoder = fs.readFileSync(path.join(__dirname, '..', 'extensions/video-playback-mpv/AdvancedVideoDecoder.cs'), 'utf8');
  assert(nativeHost.includes('GetWindowThreadProcessId') && nativeHost.includes('actual!=expected') && nativeHost.includes('SetParent(child,parent)'));
  assert(!decoder.includes('SetParent') && !decoder.includes('--parent-hwnd') && !decoder.includes('set-bounds'), 'component must not receive or manage the Electron parent surface');
  console.log('Video playback media-input and host-owned native-surface security tests passed.');
};
run().catch(error => { console.error(error); process.exitCode = 1; });
