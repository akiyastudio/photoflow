const fs = require('node:fs');
const { spawn } = require('node:child_process');

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
if (process.env.PHOTOFLOW_TEST_GRANDCHILD_PID) fs.writeFileSync(process.env.PHOTOFLOW_TEST_GRANDCHILD_PID, String(child.pid));
setInterval(() => {}, 1000);
