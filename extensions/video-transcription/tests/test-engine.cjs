const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-transcription-engine-'));
(async () => { try {
  const inputPath = path.join(root, 'fixture.mp4'); const outputPath = path.join(root, 'fixture.srt'); fs.writeFileSync(inputPath, '第一句\n第二句');
  const configured = String(process.env.PHOTOFLOW_TRANSCRIPTION_PYTHON || ''); const privatePython = process.platform === 'win32' ? path.resolve(__dirname, '..', '.venv', 'Scripts', 'python.exe') : path.resolve(__dirname, '..', '.venv', 'bin', 'python');
  const command = configured || (fs.existsSync(privatePython) ? privatePython : process.platform === 'win32' ? 'py' : 'python3'); const prefix = command === 'py' ? ['-3'] : [];
  const secondInput = path.join(root, 'second.wav'); const secondOutput = path.join(root, 'second.srt'); fs.writeFileSync(secondInput, '第三句');
  const requests = [
    { type: 'transcribe', requestId: 'one', inputPath, outputPath, options: { language: 'zh', simplifyChinese: true } },
    { type: 'transcribe', requestId: 'two', inputPath: secondInput, outputPath: secondOutput, options: { language: 'zh', simplifyChinese: true } },
    { type: 'shutdown' },
  ];
  const result = spawnSync(command, [...prefix, path.resolve(__dirname, '..', 'engine.py')], { input: `${requests.map(JSON.stringify).join('\n')}\n`, encoding: 'utf8', env: { ...process.env, PHOTOFLOW_TRANSCRIPTION_FAKE: '1', PYTHONUTF8: '0', PYTHONIOENCODING: 'gbk' } });
  assert.equal(result.status, 0, result.stderr); const frames = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)); const results = frames.filter(frame => frame.type === 'result'); assert.deepEqual(results.map(frame => frame.requestId), ['one', 'two']); assert.equal(results[0].segments.length, 2);
  assert.deepEqual(results[0].segments.map(segment => segment.text), ['第一句', '第二句'], 'the engine protocol remains UTF-8 when the packaged environment requests a Windows ANSI code page');
  const srt = fs.readFileSync(outputPath, 'utf8').replace(/\r\n/g, '\n'); assert.match(srt, /^\ufeff1\n00:00:00,000 --> 00:00:01,500\n第一句/m); assert.match(srt, /2\n00:00:01,500 --> 00:00:03,000\n第二句/);
  assert(fs.existsSync(secondOutput));
  const { runEngine } = require('../service.cjs'); const savedExecutable = process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE; const savedPrefix = process.env.PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX;
  const runWithDeadline = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('engine promise did not settle')), 3000))]);
  try {
    process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE = path.join(root, 'missing-transcriber.exe'); delete process.env.PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX;
    await assert.rejects(runWithDeadline(runEngine({ row: { id: 'spawn-error', operation_id: 'spawn-error', private_path: inputPath }, settings: {}, outputPath: path.join(root, 'missing.srt'), signal: new AbortController().signal, onProgress: async () => {} })), /无法启动|ENOENT|运行时/);
    process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE = process.execPath; process.env.PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX = JSON.stringify([path.join(__dirname, 'fake-transcriber.cjs')]);
    await assert.rejects(runWithDeadline(runEngine({ row: { id: 'progress-error', operation_id: 'progress-error', private_path: inputPath }, settings: {}, outputPath: path.join(root, 'progress-error.srt'), signal: new AbortController().signal, onProgress: async () => { throw new Error('simulated progress failure'); } })), /simulated progress failure/);
  } finally { if (savedExecutable === undefined) delete process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE; else process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE = savedExecutable; if (savedPrefix === undefined) delete process.env.PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX; else process.env.PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX = savedPrefix; }
  console.log('video-transcription persistent engine, single-settle process race, and progress rejection tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); } })().catch(error => { console.error(error); process.exitCode = 1; });
