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
  .run('project', 'outbox', 'working-output', 'fingerprint', 'stable-working-key', 'host-stage', JSON.stringify([{ sourcePath: path.join(root, 'deleted-source.png'), digest }]), JSON.stringify([{ outputRelativePath: relativePath, replacement: null }]));
db.prepare("UPDATE team_output_outbox SET result_json=? WHERE id='outbox'").run(JSON.stringify({ continuationPlan: { version: 1, kind: 'working-output', projectId: 'project', ledgerPath: path.join(dataPath, 'output-ownership', projectHashForTest(), 'working-images.json'), outputRelativePath: relativePath } })); db.close();
function projectHashForTest() { return crypto.createHash('sha256').update('project').digest('hex'); }
db = new DatabaseSync(databasePath); db.function('team_request_id', () => ''); const now = Date.now();
db.prepare('INSERT INTO team_retouch_photos(project_id,photo_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('project','merge-photo','base',now,now);
db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,generation_json,created_at,updated_at) VALUES('project','merge-task','merge-photo','base',1,'One','{}','{}','missing','[{"personIndex":1}]','{"version":2}',?,?)`).run(now,now);
const mergeTarget='merged/result.tif'; const mergeReceipt={commitId:'merge-commit',idempotencyKey:'merge-key',outputs:[{artifactId:'merge-artifact',relativePath:mergeTarget,sha256:digest}]};
const mergePlan={version:1,kind:'merge-output',projectId:'project',outputProgressId:'progress',outputRelativePath:mergeTarget,versionPayloadTemplate:{photoId:'merge-photo',parentVersionId:'base',idempotencyKey:'merge-version-key',name:'Recovered',type:'team-retouch',note:'recovered',status:'draft',isFinal:false},domain:{photoId:'merge-photo',baseVersionId:'base',tasks:[{id:'merge-task',members:[1],completion:[]}],finalStatus:'merged',mergeMetrics:[]}};
db.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,'output_committed','',?,?,?,?, '',2,2)`).run('project','merge-outbox','merge-output','merge-fp','merge-key',JSON.stringify([{sourcePath:path.join(root,'gone-merge.tif'),digest}]),JSON.stringify([{outputRelativePath:mergeTarget,replacement:null}]),JSON.stringify(mergeReceipt),JSON.stringify({continuationPlan:mergePlan}));
const workflowTarget='团片协作/week/a.png'; const workflowReceipt={commitId:'workflow-commit',idempotencyKey:'workflow-key',outputs:[{artifactId:'workflow-artifact',relativePath:workflowTarget,sha256:digest}]}; const manifestPath=path.join(dataPath,'workflows',`${projectHashForTest()}.json`);
const workflowPlan={version:1,kind:'workflow-output',projectId:'project',manifestPath,manifest:{version:2,projectId:'project',generatedAt:99,fingerprint:'workflow-fp',groups:[],outputOwnership:{}},workflowState:{generatedAt:99,fingerprint:'workflow-fp'},outputs:[{outputRelativePath:workflowTarget}]};
db.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,'output_committed','',?,?,?,?, '',3,3)`).run('project','workflow-outbox','workflow-output','workflow-row-fp','workflow-key',JSON.stringify([{sourcePath:path.join(root,'gone-workflow.png'),digest}]),JSON.stringify([{outputRelativePath:workflowTarget,replacement:null}]),JSON.stringify(workflowReceipt),JSON.stringify({continuationPlan:workflowPlan})); db.close();
let commitCalls = 0; let materializeCalls = 0; let versionCalls = 0; let rollbackCalls = 0;
const capabilities = {
  'component.storage': () => ({ dataPath, dataRoot: dataPath, databasePath, projectId: 'project' }),
  'project.output': payload => {
    if (payload.action === 'commit') { commitCalls += 1; return { commitId: 'commit-b', idempotencyKey: payload.idempotencyKey, outputs: [{ artifactId: 'artifact-b', relativePath, sha256: digest }] }; }
    if (payload.action === 'materializeOwned') { materializeCalls += 1; const privatePath = path.join(dataPath, 'projects', crypto.createHash('sha256').update('project').digest('hex'), 'materialized.png'); fs.mkdirSync(path.dirname(privatePath), { recursive: true }); fs.writeFileSync(privatePath, 'published'); return { privatePath, sha256: digest }; }
    if (payload.action === 'rollback') { rollbackCalls += 1; return { stageId: payload.stageId, rolledBack: true }; }
    throw new Error(`unexpected output action ${payload.action}`);
  },
  'version.create': payload => { versionCalls += 1; assert.equal(payload.commitId,'merge-commit'); assert.equal(payload.artifactId,'merge-artifact'); return {versionId:'version-b',result:{success:true,photo:{id:'merge-photo'},versions:[]}}; },
};
const runServiceMutation = async name => {
  const simulator = createHostSimulator({ service: path.join(__dirname, '..', 'service.cjs'), context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'project' }, capabilities });
  try { return await simulator.request('team.identity.save.v1', { name, assignments: [] }); } finally { await simulator.close(); }
};
(async () => {
  try {
    await runServiceMutation('first-process');
    db = new DatabaseSync(databasePath, { readOnly: true }); assert.equal(db.prepare("SELECT state FROM team_output_outbox WHERE id='outbox'").get().state, 'completed'); db.close();
    assert.equal(commitCalls, 1); assert.equal(materializeCalls, 1); assert.equal(versionCalls,1); assert.equal(fs.existsSync(path.join(root, 'deleted-source.png')), false);
    db=new DatabaseSync(databasePath,{readOnly:true}); assert.equal(db.prepare("SELECT merged_version_id FROM team_patch_tasks WHERE id='merge-task'").get().merged_version_id,'version-b'); assert.equal(db.prepare("SELECT fingerprint FROM team_workflow_state WHERE project_id='project'").get().fingerprint,'workflow-fp'); db.close(); assert.equal(JSON.parse(fs.readFileSync(manifestPath,'utf8')).outputOwnership[workflowTarget].artifactId,'workflow-artifact');
    await runServiceMutation('second-process');
    assert.equal(commitCalls, 1, 'a restarted service does not duplicate recovered Host output'); assert.equal(materializeCalls, 1);
    db = new DatabaseSync(databasePath); const insert = db.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,'planned','','[]','[]','{}',?,'',?,?)`);
    for (let index = 0; index < 25; index += 1) insert.run('project', `planned-${index}`, 'working-output', `planned-fp-${index}`, `planned-key-${index}`, JSON.stringify({ continuationPlan: { version: 1, kind: 'working-output', projectId: 'project', ledgerPath: path.join(dataPath, 'unused.json'), outputRelativePath: `unused-${index}` } }), 10 + index, 10 + index);
    insert.run('project', 'host-staging', 'working-output', 'host-staging-fp', 'host-staging-key', JSON.stringify({ continuationPlan: { version: 1, kind: 'working-output', projectId: 'project', ledgerPath: path.join(dataPath, 'unused.json'), outputRelativePath: 'unused-stage' } }), 40, 40); db.prepare("UPDATE team_output_outbox SET state='host_staging',stage_id='partial-stage' WHERE id='host-staging'").run();
    db.close(); await runServiceMutation('drain-more-than-one-batch');
    db = new DatabaseSync(databasePath, { readOnly: true }); assert.equal(db.prepare("SELECT COUNT(*) count FROM team_output_outbox WHERE id LIKE 'planned-%' AND state='completed'").get().count, 25, 'drain exhausts rows beyond the first LIMIT batch'); assert.equal(db.prepare("SELECT state FROM team_output_outbox WHERE id='host-staging'").get().state,'completed'); db.close(); assert.equal(rollbackCalls,1,'host_staging is safely rolled back before admitting new work');
    db = new DatabaseSync(databasePath); db.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES('project','malformed','working-output','malformed-fp','malformed-key','output_committed','','[]','[]','{}','{}','',100,100)`).run(); db.close();
    await assert.rejects(runServiceMutation('must-not-commit'), error => error.code === 'COMPONENT_RECOVERY_REQUIRED');
    db = new DatabaseSync(databasePath, { readOnly: true }); assert.equal(db.prepare("SELECT COUNT(*) count FROM team_person_identities WHERE name='must-not-commit'").get().count, 0, 'malformed non-terminal recovery blocks the new mutation before domain side effects'); db.close();
    console.log('Team-retouch source-independent output outbox restart recovery tests passed');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
})().catch(error => { console.error(error); process.exitCode = 1; });
