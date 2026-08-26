const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureSchema, projectMigrationCommittedKey } = require('../service.cjs');
const { createHostSimulator } = require('./host-simulator.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-project-get-performance-'));
const dataPath = path.join(sandbox, 'component-storage');
const databasePath = path.join(dataPath, 'storage.sqlite3');
fs.mkdirSync(dataPath, { recursive: true });
const db = ensureSchema(databasePath);
db.exec('BEGIN');
const photo = db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,display_name,relative_path,relative_path_state,file_missing,calibrated_at,created_at,updated_at) VALUES(?,?,?,?,?,'ready',0,?,?,?)`);
const task = db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,created_at,updated_at) VALUES(?,?,?,?,?,'{}','{}',?,'[]',?,?)`);
const exclusion = db.prepare(`INSERT INTO team_person_exclusions(id,project_id,photo_id,base_version_id,bbox_json,created_at) VALUES(?,?,?,?, '{}',?)`);
for (let index = 0; index < 2000; index += 1) {
  const photoId = `photo-${index}`; const versionId = `version-${index}`;
  photo.run(photoId, 'project-performance', versionId, `Photo ${index}`, `images/${index}.jpg`, 1, index + 1, index + 1);
  task.run(`task-${index}`, photoId, versionId, 1, '人物 1', `working/${index}.png`, index + 1, index + 1);
  if (index % 3 === 0) exclusion.run(`excluded-${index}`, 'project-performance', photoId, versionId, index + 1);
}
db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(projectMigrationCommittedKey('project-performance'), 'committed');
db.exec('COMMIT'); db.close();

let metadataIpcCount = 0;
const simulator = createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'project-performance', projectName: 'Performance', projectStatus: 'active' },
  capabilities: {
    'component.storage.v2': () => ({ apiVersion: 2, dataPath, databasePath, projectId: 'project-performance', ownership: 'component-private' }),
    'project.media.variants.v2': () => { metadataIpcCount += 1; throw new Error('project.get must not issue per-photo metadata IPC'); },
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
    console.log(`Team-retouch project.get performance passed: 2000 photos in ${elapsedMs.toFixed(1)}ms, ${metadataIpcCount} per-photo Host IPC`);
  } finally { simulator.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
