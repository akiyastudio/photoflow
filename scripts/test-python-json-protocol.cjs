const assert = require('assert');

const {
  findPythonJsonFailureMessage,
  parsePythonJsonMessages,
  classifyPythonJsonMessage,
} = require('../electron/services/python-json-protocol.cjs');

const messages = parsePythonJsonMessages([
  'native helper banner',
  JSON.stringify({ type: 'progress', message: '正在导出视频…', progress: 42 }),
  JSON.stringify({ type: 'error', message: 'FFmpeg 无法写入目标文件' }),
  '',
].join('\n'));

assert.deepStrictEqual(messages.map(message => message.type), ['progress', 'error']);
assert.strictEqual(findPythonJsonFailureMessage(messages), 'FFmpeg 无法写入目标文件');
assert.strictEqual(findPythonJsonFailureMessage([
  { type: 'error', message: '早期错误' },
  { type: 'cancelled', message: '视频导出已取消' },
]), '视频导出已取消');
assert.strictEqual(findPythonJsonFailureMessage([{ type: 'success', message: '完成' }]), '');
assert.deepStrictEqual(classifyPythonJsonMessage({ type: 'error', message: '' }), { kind: 'error', message: '' });
assert.deepStrictEqual(classifyPythonJsonMessage({ type: 'progress' }), { kind: 'progress' });

console.log('Python JSON protocol diagnostics regression tests passed');
