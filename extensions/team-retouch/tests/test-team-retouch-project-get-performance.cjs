const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureSchema } = require('../service.cjs');
const { createHostSimulator } = require('./host-simulator.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-project-get-performance-'));
const dataPath = path.join(sandbox, 'component-storage');
const databasePath = path.join(dataPath, 'storage.sqlite3');
fs.mkdirSync(dataPath, { recursive: true });
const db = ensureSchema(databasePath);
db.exec('BEGIN');
const photo = db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,display_name,relative_path,relative_path_state,file_missing,created_at,updated_at) VALUES(?,?,?,?,?,'ready',0,?,?)`);
const task = db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,generation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,?,?,?,?)`);
const exclusion = db.prepare(`INSERT INTO team_person_exclusions(id,project_id,photo_id,base_version_id,bbox_json,created_at) VALUES(?,?,?,?, '{}',?)`);
db.prepare('INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('identity-performance', 'project-performance', '旧姓名', '#2563eb', 1, 1);
const assignment = db.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at) VALUES(?,?,?,?,?,1,'manual',0,?)`);
for (let index = 0; index < 2000; index += 1) {
  const photoId = `photo-${index}`; const versionId = `version-${index}`;
  photo.run(photoId, 'project-performance', versionId, `Photo ${index}`, `images/${index}.jpg`, index + 1, index + 1);
  task.run('project-performance', `task-${index}`, photoId, versionId, 1, '人物 1', `working/${index}.png`, '[{"personIndex":1}]', '{"version":2}', index + 1, index + 1);
  assignment.run('project-performance', photoId, versionId, 1, 'identity-performance', index + 1);
  if (index % 3 === 0) exclusion.run(`excluded-${index}`, 'project-performance', photoId, versionId, index + 1);
}
db.exec('COMMIT'); db.close();

let metadataIpcCount = 0;
const simulator = createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'project-performance', projectName: 'Performance', projectStatus: 'active' },
  capabilities: {
    'component.storage': () => ({ dataPath, databasePath, projectId: 'project-performance', ownership: 'component-private' }),
    'project.media.variants': () => { metadataIpcCount += 1; throw new Error('project.get must not issue per-photo metadata IPC'); },
  },
});

(async () => {
  try {
    await simulator.request('team.project.get.v1');
    const startedAt = performance.now();
    const snapshot = await simulator.request('team.project.get.v1');
    const elapsedMs = performance.now() - startedAt;
    assert.equal(snapshot.photos.length, 2000);
    assert.equal(metadataIpcCount, 0, 'the 2000-photo hot path is served entirely by the component read model');
    assert(snapshot.photos.some(item => item.excludedPersonCount === 1), 'excluded counts are included by the grouped read');
    assert(elapsedMs < 300, `2000-photo project.get hot path exceeded 300ms: ${elapsedMs.toFixed(1)}ms`);
    const renameStartedAt = performance.now();
    await simulator.request('team.identity.save.v1', { identityId: 'identity-performance', name: '新姓名', assignments: [] });
    const renameElapsedMs = performance.now() - renameStartedAt;
    const verifyDb = ensureSchema(databasePath);
    assert.equal(verifyDb.prepare("SELECT COUNT(*) count FROM team_patch_tasks WHERE project_id='project-performance' AND person_name='新姓名'").get().count, 2000, 'set-based identity rename updates all 2000 task labels atomically');
    verifyDb.close();
    assert.equal(metadataIpcCount, 0, 'identity rename must not introduce per-task Host/RPC fanout');
    assert(renameElapsedMs < 800, `2000-task identity rename exceeded 800ms: ${renameElapsedMs.toFixed(1)}ms`);
    console.log(`Team-retouch project.get performance passed: 2000 photos in ${elapsedMs.toFixed(1)}ms; identity rename ${renameElapsedMs.toFixed(1)}ms, ${metadataIpcCount} per-photo Host IPC`);
  } finally { await simulator.close(); try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 }); } catch {} }
})().catch(error => { console.error(error); process.exitCode = 1; });
