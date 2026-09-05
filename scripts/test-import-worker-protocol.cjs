const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeImportVideoToolRequest, importWorkerCompletionIssue, serializeImportWorkerControl } = require('../electron/contracts/import-worker-protocol.cjs');

const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const program = String.raw`
import base64, contextlib, io, json, sys, types
sys.path.insert(0, sys.argv[1])
import worker
fake = types.ModuleType('ffmpeg_transcode')
fake.probe_creation_time_values = lambda input_path: [input_path]
fake.transcode_video_preview = lambda *args, **kwargs: 'fake-encoder'
fake.split_video_by_size = lambda input_path, **kwargs: [input_path]
fake.transcode_video = lambda input_path, **kwargs: kwargs['destination_directory'] + '/output.mp4'
sys.modules['ffmpeg_transcode'] = fake
request = json.load(sys.stdin)
cases = request['cases']
assert json.loads(bytes.fromhex(request['controlHex']).decode('gbk')) == request['control']
for case in cases:
    encoded, payload = case['encoded'], case['payload']
    # The host must remain compatible with the unmodified installed decoder.
    assert json.loads(base64.urlsafe_b64decode(encoded)) == payload
    for value in [encoded, encoded.rstrip('=').replace('+', '-').replace('/', '_')]:
        output = io.BytesIO()
        stream = io.TextIOWrapper(output, encoding='gbk')
        with contextlib.redirect_stdout(stream):
            worker.bridge(value)
        stream.flush()
        result = json.loads(output.getvalue().decode('ascii'))
        assert result['success'] is True
        expected = {
            'probe-creation-time': {'values': [payload['inputPath']]},
            'preview': {'encoder': 'fake-encoder', 'outputPath': payload['outputPath']},
            'split': {'outputs': [payload['inputPath']]},
            'transcode': {'outputPath': payload['destinationDirectory'] + '/output.mp4'},
        }[payload['action']]
        assert result['result'] == expected, (result, expected)
print('Cross-language video bridge: all actions and padding lengths passed')
`;

const cases = [];
const remainders = new Set();
for (const action of ['probe-creation-time', 'preview', 'split', 'transcode']) {
  for (const suffix of ['', 'x', 'xx']) {
    const payload = {
      inputPath: `C:\\素材\\相机 A 📷\\${suffix}视频.MP4`,
      outputPath: 'C:\\素材\\预览.mp4', destinationDirectory: 'C:\\素材\\花絮_转码',
      settings: { videoMode: 'h265', resolution: '1080p' },
    };
    const encoded = encodeImportVideoToolRequest(payload, action);
    remainders.add(encoded.replace(/=+$/, '').length % 4);
    cases.push({ encoded, payload: { ...payload, action } });
  }
}
assert.deepEqual([...remainders].sort(), [0, 2, 3]);
const control = { type: 'video_tool_result', requestId: 'video-1', ok: true, result: { outputPath: 'D:\\照片流\\花絮_转码\\视频 📷.mp4' } };
const serialized = serializeImportWorkerControl(control);
assert(!/[^\x00-\x7f]/.test(serialized), 'worker control messages must be independent of the Windows code page');
assert.equal(serialized.at(-1), '\n');
const run = spawnSync(python, ['-c', program, path.join(root, 'extensions/video-tools/runtime')], {
  input: JSON.stringify({ cases, control, controlHex: Buffer.from(serialized).toString('hex') }), encoding: 'utf8', windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
});
assert.equal(run.status, 0, run.error?.message || run.stderr || run.stdout);
process.stdout.write(run.stdout);

assert.equal(importWorkerCompletionIssue({ type: 'success', data: { importedCount: 2, sourceFilesDeleted: true } }, true), '');
assert.equal(importWorkerCompletionIssue({ type: 'success', data: { importedCount: 2, sourceFilesDeleted: false } }), '', 'startup and copy-only imports intentionally retain sources');
assert.equal(importWorkerCompletionIssue({ type: 'success', data: { skipped: true, importedCount: 0, sourceFilesDeleted: false } }, true), '');
assert.equal(importWorkerCompletionIssue({ type: 'ask_user', data: { partialFailure: true } }), '');
for (const event of [
  { type: 'partial', data: {} },
  { type: 'success', data: { partialFailure: true, sourceFilesDeleted: false } },
  { type: 'success', data: { failedCount: 1 } },
  { type: 'success', data: { importedCount: 2, sourceFilesDeleted: false } },
]) {
  assert(importWorkerCompletionIssue(event, true), 'incomplete post-processing or requested cleanup must not be reported as full success');
}
console.log('Import task completion reporting tests passed');
