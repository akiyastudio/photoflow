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
for (const marker of ['video-tools.transcode.v1', 'video-tools.split.v1', 'video-tools.sources.preview.v1', 'video.sources.preview', 'project.media.process', 'directoryToken: true', 'normalizePresets', 'transcodePresets']) assert(service.includes(marker));

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
