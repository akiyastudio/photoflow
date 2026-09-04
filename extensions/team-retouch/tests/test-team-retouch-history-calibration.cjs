const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureSchema, projectMigrationCommittedKey } = require('../service.cjs');
const { createHostSimulator } = require('./host-simulator.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-history-calibration-'));
const dataPath = path.join(sandbox, 'component-storage');
const databasePath = path.join(dataPath, 'storage.sqlite3');
const projectId = 'history-project';
fs.mkdirSync(dataPath, { recursive: true });
const workingPath = path.join(dataPath, 'working.png'); fs.writeFileSync(workingPath, 'working');
const db = ensureSchema(databasePath);
db.exec('BEGIN');
const insertPhoto = db.prepare(`INSERT INTO team_retouch_photos(project_id,photo_id,base_version_id,display_name,relative_path,relative_path_state,file_missing,calibrated_at,created_at,updated_at) VALUES(?,?,?,'','','unresolvable',0,0,1,1)`);
const insertTask = db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,'[]',1,1)`);
const insertAssignment = db.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,confidence,source,completed,updated_at) VALUES(?,?,?,?,0,'manual',0,1)`);
for (let photoIndex = 0; photoIndex < 21; photoIndex += 1) {
  const photoId = `photo-${photoIndex}`; const versionId = `version-${photoIndex}`;
  insertPhoto.run(projectId, photoId, versionId);
  const taskCount = photoIndex === 0 ? 4 : 3;
  for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) insertTask.run(projectId, `task-${photoIndex}-${taskIndex}`, photoId, versionId, taskIndex + 1, `人物 ${taskIndex + 1}`, workingPath);
}
for (let assignmentIndex = 0; assignmentIndex < 140; assignmentIndex += 1) {
  const photoIndex = assignmentIndex % 21;
  insertAssignment.run(projectId, `photo-${photoIndex}`, `version-${photoIndex}`, Math.floor(assignmentIndex / 21) + 1);
}
insertPhoto.run('other-project', 'photo-0', 'version-0');
db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(projectMigrationCommittedKey(projectId), 'committed');
db.exec('COMMIT'); db.close();

let metadataRequests = 0;
let failMetadata = true;
const simulator = createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId, projectName: 'History', projectStatus: 'active' },
  capabilities: {
    'component.storage': () => ({ apiVersion: 7, dataPath, databasePath, projectId, ownership: 'component-private' }),
    'project.media.variants': payload => {
      metadataRequests += 1;
      if (failMetadata) return Promise.reject(new Error('temporary Host metadata failure'));
      const relativePath = `images/${payload.photoId}.jpg`;
      return {
        apiVersion: 7,
        mediaRef: { photoId: payload.photoId, versionId: payload.versionId, relativePath },
        metadata: { photoId: payload.photoId, versionId: payload.versionId, currentVersionId: payload.versionId, relativePath, displayName: `${payload.photoId}.jpg`, originalName: `${payload.photoId}.jpg`, isCurrent: true, fileMissing: false },
        variants: {},
      };
    },
  },
});

(async () => {
  try {
    const before = await simulator.request('team.project.get.v1');
    assert.deepEqual({ photos: before.photos.length, tasks: before.photos.flatMap(photo => photo.tasks).length, assignments: before.assignments.length, pending: before.calibration.pendingCount }, { photos: 21, tasks: 64, assignments: 140, pending: 21 });
    assert(before.photos.every(photo => !photo.relativePath));
    const failedAttempt = await simulator.request('team.project.calibrate-step.v1', { maxItems: 48, expectedRevision: before.revision });
    assert.deepEqual({ attempted: failedAttempt.attemptedCount, calibrated: failedAttempt.calibratedCount, failed: failedAttempt.failedCount, pending: failedAttempt.pendingCount }, { attempted: 21, calibrated: 0, failed: 21, pending: 21 }, 'a transient Host failure remains retryable instead of becoming a terminal empty calibration');
    const failedDb = ensureSchema(databasePath);
    assert.equal(failedDb.prepare("SELECT COUNT(*) count FROM team_retouch_photos WHERE project_id=? AND (relative_path<>'' OR calibrated_at<>0)").get(projectId).count, 0);
    failedDb.close();
    failMetadata = false;
    const calibrated = await simulator.request('team.project.calibrate-step.v1', { maxItems: 48, expectedRevision: failedAttempt.revision });
    assert.deepEqual({ attempted: calibrated.attemptedCount, calibrated: calibrated.calibratedCount, resolved: calibrated.resolvedCount, failed: calibrated.failedCount, pending: calibrated.pendingCount }, { attempted: 21, calibrated: 21, resolved: 21, failed: 0, pending: 0 });
    assert.equal(metadataRequests, 42);
    const after = await simulator.request('team.project.get.v1');
    assert(after.photos.every(photo => photo.relativePath === `images/${photo.photoId}.jpg` && photo.relativePathState === 'ready' && !photo.fileMissing));
    assert.deepEqual({ tasks: after.photos.flatMap(photo => photo.tasks).length, assignments: after.assignments.length }, { tasks: 64, assignments: 140 }, 'path calibration preserves task and identity history');
    const verified = ensureSchema(databasePath);
    assert.deepEqual({ ...verified.prepare("SELECT relative_path,calibrated_at FROM team_retouch_photos WHERE project_id='other-project' AND photo_id='photo-0' AND base_version_id='version-0'").get() }, { relative_path: '', calibrated_at: 0 }, 'calibration never touches another project even when photo and version ids are identical');
    verified.close();
    console.log('Team-retouch blocking history calibration tests passed');
  } finally {
    simulator.close();
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (error) { if (error.code !== 'EPERM') throw error; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
