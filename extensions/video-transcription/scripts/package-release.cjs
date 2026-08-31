const path = require('node:path');
const { spawnSync } = require('node:child_process');

const run = (script, args = []) => {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
};

run('build-runtime.cjs');
run('package-component.cjs', process.argv.slice(2));
