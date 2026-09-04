const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'backup-restore.cjs'), 'utf8');
assert(source.includes('projects/${sourceHash}/'));
assert(source.includes('projects/${targetHash}/'));
assert(source.includes('workflow-return-reviews/${sourceHash}/'));
assert.equal(/legacy-domain|unversioned|sourceName|sourceStatus|projectName|projectStatus/.test(source), false);
console.log('Team-retouch current private restore routing contract passed');
