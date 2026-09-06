const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArguments } = require('./package-host.cjs');
const { baseOutputRoot } = require('./package-output-paths.cjs');
const root = path.resolve(__dirname, '..');
const { outputDirectory } = parseArguments(process.argv.slice(2));
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Formal base packaging failed (${result.status})`);
};
run([path.join(__dirname, 'setup-python.cjs')]);
run([path.join(__dirname, 'package-component.cjs'), '--output-dir', outputDirectory || baseOutputRoot]);
