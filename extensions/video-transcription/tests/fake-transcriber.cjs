const fs = require('node:fs');
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (process.env.PHOTOFLOW_TRANSCRIBER_PROCESS_LOG) fs.appendFileSync(process.env.PHOTOFLOW_TRANSCRIBER_PROCESS_LOG, `${process.pid}\n`);
lines.on('line', line => {
  const request = JSON.parse(line); if (request.type === 'shutdown') { lines.close(); return; }
  const requestId = request.requestId; const text = fs.readFileSync(request.inputPath, 'utf8');
  if (text.includes('FAIL_TRANSCRIPTION')) { emit({ type: 'error', requestId, message: 'isolated test failure' }); return; }
  const run = () => {
    const values = text.split(/\r?\n/).map(value => value.trim()).filter(value => value && value !== 'SLOW_TRANSCRIPTION');
    const segments = (values.length ? values : ['测试字幕']).map((value, index) => ({ seq: index + 1, start: index * 1.25, end: (index + 1) * 1.25, text: value }));
    const srt = segments.map((item, index) => `${index + 1}\n00:00:0${index},000 --> 00:00:0${index + 1},250\n${item.text}\n`).join('\n');
    fs.mkdirSync(require('node:path').dirname(request.outputPath), { recursive: true }); fs.writeFileSync(request.outputPath, `\ufeff${srt}`);
    emit({ type: 'progress', requestId, progress: 100, segments: segments.length }); emit({ type: 'result', requestId, language: 'zh', segments, cpuFallback: false });
  };
  if (text.includes('SLOW_TRANSCRIPTION')) setTimeout(run, 1800); else run();
});
