const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const entry = fs.readFileSync(path.resolve(__dirname, '..', 'renderer/src/legacy-main.tsx'), 'utf8');
assert(entry.includes("teamProjectRpc<Json>('team.project.get.v1')"));
assert(entry.includes("teamProjectRpc<Json>('team.project.register.v1'"));
assert(entry.includes('drainTeamWorkflowReconciles({ maxItems: 4 })'));
assert.equal(/migrate-step|calibrateTeamProjectWorkspace|legacyMigration/.test(entry), false);
console.log('Team-retouch current history load contract passed');
