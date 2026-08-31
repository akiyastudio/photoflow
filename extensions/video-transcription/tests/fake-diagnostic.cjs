const fs = require('node:fs');
const logPath = String(process.env.PHOTOFLOW_TRANSCRIBER_PROCESS_LOG || '');
if (logPath) fs.appendFileSync(logPath, `${process.pid}\n`);
process.stdout.write(`${JSON.stringify({ type: 'diagnostic-result', ready: true, missing: [], packaged: true })}\n`);
