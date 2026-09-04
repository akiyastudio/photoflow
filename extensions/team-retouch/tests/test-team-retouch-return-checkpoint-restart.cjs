const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../service.cjs');
const { createHostSimulator } = require('./host-simulator.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-return-restart-')); const dataPath = path.join(root, 'data'); const databasePath = path.join(dataPath, 'storage.sqlite3');
const projectHash = crypto.createHash('sha256').update('project').digest('hex'); const mediaRoot = path.join(dataPath, 'projects', projectHash, 'media', 'photo', 'base'); fs.mkdirSync(mediaRoot, { recursive: true });
const basePath = path.join(root, 'base.png'); const patch1 = path.join(mediaRoot, 'task-1.png'); const patch2 = path.join(mediaRoot, 'task-2.png'); const completedReturn = path.join(root, 'completed.png'); const pendingReturn = path.join(root, 'pending.png'); const priorArtifact = path.join(mediaRoot, 'prior-return.png');
for (const [file, value] of [[basePath,'base'],[patch1,'p1'],[patch2,'p2'],[completedReturn,'done'],[pendingReturn,'pending'],[priorArtifact,'done']]) fs.writeFileSync(file, value);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let db = ensureSchema(databasePath); const now = Date.now(); db.prepare('INSERT INTO team_retouch_photos(project_id,photo_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('project','photo','base',now,now);
const insertTask = db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,generation_json,created_at,updated_at) VALUES(?,?,?,?,?,?, '{}','{}',?,?,?, ?,?)`);
insertTask.run('project','task-1','photo','base',1,'One',patch1,JSON.stringify([{personIndex:1}]),JSON.stringify({version:2}),now,now); insertTask.run('project','task-2','photo','base',2,'Two',patch2,JSON.stringify([{personIndex:2}]),JSON.stringify({version:2}),now,now);
db.prepare(`INSERT INTO team_task_artifacts(project_id,id,task_id,person_index,kind,artifact_path,created_at) VALUES(?,?,?,?,?,?,?)`).run('project','artifact-1','task-1',1,'returned',priorArtifact,now);
db.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,completed,completion_kind,artifact_id,edited_patch_path,task_id,updated_at) VALUES(?,?,?,?,1,'returned',?,?,?,?)`).run('project','photo','base',1,'artifact-1',priorArtifact,'task-1',now);
const completedTuple = ['task-1','photo','base','1'].join('\0'); const completed = {}; completed[`${digest(completedReturn)}\0${completedTuple}`] = { digest: digest(completedReturn), taskId:'task-1',photoId:'photo',baseVersionId:'base',personIndex:1 };
db.prepare(`INSERT INTO team_durable_operations(id,project_id,kind,state,phase,request_json,checkpoint_json,base_revision,created_at,updated_at) VALUES(?,?,'return-batch','accepted','accepted',?,?,0,1,1)`).run('old-operation','project',JSON.stringify({operationId:'old-operation',workflowMode:false}),JSON.stringify({completed})); db.close();
let tokenCounter = 0; const capabilities = {
  'component.storage': () => ({dataPath,dataRoot:dataPath,databasePath,projectId:'project'}), tasks: () => ({task:null,cancelled:false}), 'component.events': () => ({emitted:true}),
  'project.media.variants': () => ({mediaRef:{photoId:'photo',versionId:'base'},metadata:{photoId:'photo',versionId:'base',currentVersionId:'base',relativePath:'photo.png'},input:{token:'base-token'}}),
  'project.input.tokens': payload => { const source = payload.token === 'base-token' ? basePath : payload.token === 'completed-token' ? completedReturn : pendingReturn; const directory = path.join(dataPath,'inputs',String(++tokenCounter)); fs.mkdirSync(directory,{recursive:true}); const privatePath=path.join(directory,path.basename(source)); fs.copyFileSync(source,privatePath); return {inputId:String(tokenCounter),privatePath}; },
};
const simulator = createHostSimulator({service:path.join(__dirname,'..','service.cjs'),serviceArgs:['--photoflow-development-command',process.execPath,'--photoflow-development-arg',path.join(__dirname,'fixture-return-matcher.cjs')],context:{componentId:'team-retouch',componentVersion:'test',surface:'project',projectId:'project'},capabilities});
(async()=>{try{
  const accepted=await simulator.request('team.patch.return-batch.v1',{acceptOnly:true,operationId:'old-operation',returnedFiles:['pending-token','completed-token']}); assert.equal(accepted.cacheHit,true);
  const result=await simulator.request('team.operation.run.v1',{operationId:'old-operation'}); assert.equal(result.acceptedCount,2); assert(result.matches.some(item=>item.resumed));
  db=new DatabaseSync(databasePath,{readOnly:true}); assert.equal(db.prepare("SELECT COUNT(*) count FROM team_task_artifacts WHERE project_id='project'").get().count,2,'only the unfinished return is archived after restart/reselection'); db.close();
  console.log('Team-retouch reordered reselection checkpoint restart tests passed');
}finally{await simulator.close();try{fs.rmSync(root,{recursive:true,force:true});}catch{}}})().catch(error=>{console.error(error);process.exitCode=1;});
