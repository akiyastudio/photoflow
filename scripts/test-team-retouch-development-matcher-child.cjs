const fs = require('fs');
const path = require('path');

const manifestIndex = process.argv.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : '';
const { runMatcher } = require('../extensions/team-retouch/service.cjs');

Promise.resolve().then(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  const result = await runMatcher(manifest.returned, manifest.candidates);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(error => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
