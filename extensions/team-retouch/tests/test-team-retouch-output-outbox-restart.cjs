const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../service.cjs');
const { createHostSimulator } = require('./host-simulator.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-outbox-restart-')); const dataPath = path.join(root, 'data'); const databasePath = path.join(dataPath, 'storage.sqlite3');
fs.mkdirSync(dataPath, { recursive: true }); const digest = crypto.createHash('sha256').update('published').digest('hex'); const relativePath = 'photos/work.png';
let db = ensureSchema(databasePath);
db.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,'commit_inflight',?,?,?,'{}','{}','',1,1)`)
  .run('project', 'outbox', 'working-output', 'fingerprint', 'stable-working-key', 'host-stage', JSON.stringify([{ sourcePath: path.join(root, 'deleted-source.png'), digest }]), JSON.stringify([{ outputRelativePath: relativePath, replacement: null }])); db.close();
let commitCalls = 0; let materializeCalls = 0;
const capabilities = {
  'component.storage': () => ({ dataPath, dataRoot: dataPath, databasePath, projectId: 'project' }),
  'project.output': payload => {
    if (payload.action === 'commit') { commitCalls += 1; return { commitId: 'commit-b', idempotencyKey: payload.idempotencyKey, outputs: [{ artifactId: 'artifact-b', relativePath, sha256: digest }] }; }
    if (payload.action === 'materializeOwned') { materializeCalls += 1; const privatePath = path.join(dataPath, 'projects', crypto.createHash('sha256').update('project').digest('hex'), 'materialized.png'); fs.mkdirSync(path.dirname(privatePath), { recursive: true }); fs.writeFileSync(privatePath, 'published'); return { privatePath, sha256: digest }; }
    throw new Error(`unexpected output action ${payload.action}`);
  },
};
const runServiceMutation = async name => {
  const simulator = createHostSimulator({ service: path.join(__dirname, '..', 'service.cjs'), context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'project' }, capabilities });
  try { return await simulator.request('team.identity.save.v1', { name, assignments: [] }); } finally { await simulator.close(); }
};
(async () => {
  try {
    await runServiceMutation('first-process');
    db = new DatabaseSync(databasePath, { readOnly: true }); assert.equal(db.prepare("SELECT state FROM team_output_outbox WHERE id='outbox'").get().state, 'completed'); db.close();
    assert.equal(commitCalls, 1); assert.equal(materializeCalls, 1); assert.equal(fs.existsSync(path.join(root, 'deleted-source.png')), false);
    await runServiceMutation('second-process');
    assert.equal(commitCalls, 1, 'a restarted service does not duplicate recovered Host output'); assert.equal(materializeCalls, 1);
    console.log('Team-retouch source-independent output outbox restart recovery tests passed');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
})().catch(error => { console.error(error); process.exitCode = 1; });
