const assert = require('assert').strict;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
const panels = manifest.componentHost.contributions.filter(item => item.type === 'component.sidePanel');
assert.deepEqual(panels.map(item => item.id), ['transcode', 'split']);
assert(panels.every(item => item.placement === 'workspace.videoTools'));
assert(panels.every(item => item.rpcMethods.includes('video-tools.sources.preview.v1')), 'both video panels must be allowed to preview folder contents');

const servicePath = path.join(root, 'service.cjs');
const service = fs.readFileSync(servicePath, 'utf8');
for (const marker of ['video-tools.transcode.v1', 'video-tools.split.v1', 'video-tools.sources.preview.v1', 'component.runtime.execute', 'runtimeRequest', 'directoryToken: true', 'normalizePresets', 'transcodePresets']) assert(service.includes(marker));

const ui = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
for (const marker of ['另存为新视频', '替换原视频', '约 3.95 GB（固定）', 'video-tools.operation.progress.v1', 'source-row', 'source-children', 'data-toggle-source', '展开全部', '批量粘贴路径', 'authorizeFiles(files)', 'data-clear-sources', 'settingsReady', 'render();\n  void api.getContext()', 'pf-button-danger', 'pf-panel-section', '编码预设', 'H.264 通用兼容', 'HEVC Main10 · 跟随来源', 'Rec.709 SDR 输出', '最大 4K', '保存为用户预设', 'data-preset-save', 'data-preset-delete']) assert(ui.includes(marker));
assert(!ui.includes('恢复当前选择'), 'plugin source picker must preserve the original clear/remove interaction');
assert(!ui.includes('Promise.all([api.getContext()'), 'transcode first paint must not wait for settings or service startup');

const style = fs.readFileSync(path.join(root, 'ui', 'style.css'), 'utf8');
assert(style.includes('.preset-bar'));
assert(!/\.source-actions button[^{}]*\{[^}]*min-height/u.test(style) && !/\nbutton\s*\{/u.test(style) && !/\n(?:select|input)\s*\{/u.test(style), 'plugin CSS must not override Host-owned button or form-control sizing');

const child = spawn(process.execPath, [servicePath], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
let settingsState = { transcode: { videoMode: 'h265' }, transcodePresets: [{ id: 'saved-1', name: '已有预设', settings: { videoMode: 'h264' } }] };
let finished = false;
const timeout = setTimeout(() => { child.kill(); assert.fail('video-tools preset persistence test timed out'); }, 5000);
const sendRequest = (id, presets) => child.stdin.write(`${JSON.stringify({ type: 'request', id, method: presets === undefined ? 'video-tools.settings.get.v1' : 'video-tools.settings.update.v1', payload: presets === undefined ? {} : { settings: { videoMode: 'h265', quality: 'high' }, presets }, context: { componentId: 'video-tools', projectId: 'project-1' } })}\n`);

lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'ready') return sendRequest('get', undefined);
  if (frame.type === 'capability') {
    if (frame.method === 'component.runtime.execute') {
      assert.equal(frame.payload.action, 'execute');
      assert.equal(frame.payload.runtimeCapability, 'media.video.processing.cli');
      assert.equal(frame.payload.arguments[0], 'ffmpeg_transcode');
      assert(frame.payload.arguments.includes('--video-mode') && frame.payload.arguments.includes('h265'));
      assert.equal(frame.payload.eventName, 'video-tools.operation.progress.v1');
      child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: true, result: {  operationId: 'runtime-operation', result: { type: 'success', report: [{ output: 'video.mp4' }], failedCount: 0 } } })}\n`);
      return;
    }
    assert.equal(frame.method, 'component.settings');
    if (frame.payload.action === 'merge') settingsState = { ...settingsState, ...frame.payload.settings };
    child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: true, result: { revision: 5, settings: settingsState } })}\n`);
    return;
  }
  if (frame.type !== 'response') return;
  assert(frame.ok, frame.error);
  if (frame.id === 'get') {
    assert.equal(frame.result.settings.videoMode, 'h265');
    assert.deepEqual(frame.result.presets.map(item => item.name), ['已有预设']);
    sendRequest('save', [{ id: 'new-1', name: '  新预设  ', settings: { videoMode: 'h265', bitDepth: '10' } }, { id: '', name: '无效', settings: {} }]);
  } else if (frame.id === 'save') {
    assert.deepEqual(settingsState.transcodePresets.map(item => item.name), ['新预设']);
    assert.equal(frame.result.presets[0].settings.bitDepth, '10');
    sendRequest('delete', []);
  } else if (frame.id === 'delete') {
    assert.deepEqual(settingsState.transcodePresets, []);
    assert.deepEqual(frame.result.presets, []);
    child.stdin.write(`${JSON.stringify({ type: 'request', id: 'transcode', method: 'video-tools.transcode.v1', payload: { idempotencyKey: 'runtime-test', relativePaths: ['video.mp4'], inputTokens: [], settings: { videoMode: 'h265' }, outputMode: 'new' }, context: { componentId: 'video-tools', projectId: 'project-1' } })}\n`);
  } else if (frame.id === 'transcode') {
    assert.equal(frame.result.operationId, 'runtime-operation');
    assert.equal(frame.result.report.length, 1);
    finished = true;
    clearTimeout(timeout);
    child.kill();
    console.log('Video tools component service, preset persistence, folder previews, immediate first paint, and Host-inherited source-picker UI contract tests passed');
  }
});

child.on('exit', code => {
  if (!finished) {
    clearTimeout(timeout);
    assert.fail(`video-tools service exited before preset persistence completed (${code})`);
  }
});
