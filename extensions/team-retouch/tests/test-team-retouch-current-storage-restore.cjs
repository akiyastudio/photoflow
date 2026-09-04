const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../service.cjs');
const { restoreProjectBundle } = require('../backup-restore.cjs');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-current-restore-'));
try {
  const sourceId = 'source-project'; const targetId = 'target-project';
  const sourceHash = hash(sourceId); const targetHash = hash(targetId);
  const sourceDataRoot = path.join(sandbox, 'old-data');
  const targetDataRoot = path.join(sandbox, 'new-data');
  const sourceComponentRoot = path.join(sourceDataRoot, 'components', 'team-retouch');
  const targetComponentRoot = path.join(targetDataRoot, 'components', 'team-retouch');
  const sourceDatabase = path.join(sandbox, 'source.sqlite3');
  const targetDatabase = path.join(targetComponentRoot, 'storage.sqlite3');
  const staleTargetFile = path.join(targetComponentRoot, 'projects', targetHash, 'stale.bin');
  const otherProjectFile = path.join(targetComponentRoot, 'projects', hash('other-project'), 'keep.bin');
  for (const [file, value] of [[staleTargetFile, 'remove-me'], [otherProjectFile, 'keep-me']]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
  const oldArtifact = path.join(sourceComponentRoot, 'projects', sourceHash, 'media', 'photo', 'version', 'artifact.bin');
  fs.mkdirSync(path.dirname(oldArtifact), { recursive: true }); fs.writeFileSync(oldArtifact, 'media-current-layout');
  const importedArtifact = path.join(sourceComponentRoot, 'imported-outputs', 'import-1', 'working.png'); fs.mkdirSync(path.dirname(importedArtifact), { recursive: true }); fs.writeFileSync(importedArtifact, 'host-materialized-working');
  const sourceDb = ensureSchema(sourceDatabase);
  sourceDb.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run(sourceId, 4);
  sourceDb.prepare(`INSERT INTO team_task_artifacts(project_id,id,task_id,stage_id,person_index,kind,artifact_path,digest,metadata_json,created_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sourceId, 'artifact', 'task', null, 1, 'patch', oldArtifact, digest(oldArtifact), JSON.stringify({ path: oldArtifact }), 1, 0);
  sourceDb.prepare(`INSERT INTO team_task_artifacts(project_id,id,task_id,stage_id,person_index,kind,artifact_path,digest,metadata_json,created_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sourceId, 'imported-artifact', 'imported-task', null, 2, 'patch', importedArtifact, digest(importedArtifact), '{}', 2, 0);
  sourceDb.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sourceId, 'outbox-a', 'working-output', 'fingerprint-a', 'source-scope-key', 'completed', 'stage-a', '[]', '[]', JSON.stringify({ commitId: 'source-commit', outputs: [{ artifactId: 'source-artifact' }] }), '{}', '', 1, 1);
  const workingPlan = { version: 1, kind: 'working-output', projectId: sourceId, preHostLocalEffects: 'none', ledgerPath: path.join(sourceComponentRoot, 'output-ownership', sourceHash, 'working-images.json'), outputRelativePath: '团片协作/old-working.png', domain: { version: 1, generationId: 'restored-generation', photoId: 'restored-photo', baseVersionId: 'restored-base', allTaskIds: ['restored-task'], task: { id: 'restored-task', personIndex: 1, personName: 'Restored', members: [{ personIndex: 1 }], generation: { version: 2 } }, photo: { displayName: 'Restored', relativePath: 'restored.jpg', relativePathState: 'ready', fileMissing: false } } };
  sourceDb.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sourceId, 'working-pending', 'working-output', 'working-pending-fp', 'working-pending-key', 'domain_pending', '', JSON.stringify([{ sourcePath: importedArtifact, digest: digest(importedArtifact) }]), JSON.stringify([{ outputRelativePath: workingPlan.outputRelativePath, replacement: null }]), JSON.stringify({ commitId: 'scope-a-working', idempotencyKey: 'working-pending-key', outputs: [{ artifactId: 'scope-a-artifact', relativePath: workingPlan.outputRelativePath, sha256: digest(importedArtifact) }] }), JSON.stringify({ continuationPlan: workingPlan, materialized: { privatePath: importedArtifact, sha256: digest(importedArtifact) } }), '', 2, 2);
  sourceDb.close();
  const staged = path.join(sandbox, 'staged'); fs.mkdirSync(staged, { recursive: true });
  const make = (name, value) => { const file = path.join(staged, name); fs.writeFileSync(file, value); return file; };
  const media = make('media.bin', 'media-current-layout');
  const importedMedia = make('imported-working.png', 'host-materialized-working');
  const settings = make('settings.json', JSON.stringify({ projectId: sourceId, path: oldArtifact }));
  const similarities = make('similarities.json', JSON.stringify({ projectId: sourceId, similarities: [] }));
  const job = make('job.json', JSON.stringify({ projectId: sourceId, projectName: 'Old', state: 'completed' }));
  const ownership = make('ownership.json', JSON.stringify({ 'output/file.png': { commitId: 'source-commit', artifactId: 'source-artifact', sha256: 'bad-scope' } }));
  const entries = [
    [`team-retouch/projects/${sourceHash}/media/photo/version/artifact.bin`, media],
    ['team-retouch/imported-outputs/import-1/working.png', importedMedia],
    [`team-retouch/workflow-settings/${sourceHash}.json`, settings],
    [`team-retouch/identity-similarities/${sourceHash}.json`, similarities],
    [`team-retouch/workflow-jobs/${hash(sourceId)}.json`, job],
    [`team-retouch/output-ownership/${sourceHash}/working-images.json`, ownership],
  ].map(([relativePath, file]) => ({ relativePath, path: file, size: fs.statSync(file).size, sha256: digest(file), format: 'component-private-v1' }));
  const payload = {
    operationId: 'restore-current-layout',
    project: { sourceId, id: targetId, sourceName: 'Old', targetName: 'New', sourceStatus: 'active', targetStatus: 'active' },
    sourceWorkspace: { dataRoot: sourceDataRoot, root: path.join(sandbox, 'old-workspace') },
    targetWorkspace: { dataRoot: targetDataRoot, root: path.join(sandbox, 'new-workspace') },
    targetStorage: { dataPath: targetComponentRoot, controlPath: path.join(targetComponentRoot, '.control') },
  };
  const result = restoreProjectBundle({
    source: { relativePath: 'team-retouch/storage.sqlite3', path: sourceDatabase, format: 'component-storage-v1' },
    sources: [{ relativePath: 'team-retouch/storage.sqlite3', path: sourceDatabase, format: 'component-storage-v1' }, ...entries],
    destinationPath: targetDatabase, destinationDataPath: targetComponentRoot, payload, ensureSchema,
  });
  assert.equal(result.status, 'committed');
  const restored = new DatabaseSync(targetDatabase, { readOnly: true });
  const artifact = restored.prepare('SELECT artifact_path,metadata_json FROM team_task_artifacts WHERE project_id=?').get(targetId); restored.close();
  const expectedArtifact = path.join(targetComponentRoot, 'projects', targetHash, 'media', 'photo', 'version', 'artifact.bin');
  assert.equal(artifact.artifact_path, expectedArtifact, 'database absolute project-private paths are rebound to the target project hash');
  assert.equal(JSON.parse(artifact.metadata_json).path, expectedArtifact, 'JSON database paths are rebound too');
  assert.equal(fs.readFileSync(expectedArtifact, 'utf8'), 'media-current-layout');
  assert.equal(fs.existsSync(staleTargetFile), false, 'exact project restore removes target-project files absent from the source snapshot');
  assert.equal(fs.readFileSync(otherProjectFile, 'utf8'), 'keep-me', 'exact project restore leaves every other project hash untouched');
  assert.equal(JSON.parse(fs.readFileSync(path.join(targetComponentRoot, 'workflow-settings', `${targetHash}.json`), 'utf8')).projectId, targetId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(targetComponentRoot, 'identity-similarities', `${targetHash}.json`), 'utf8')).projectId, targetId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(targetComponentRoot, 'workflow-jobs', `${hash(targetId)}.json`), 'utf8')).projectId, targetId);
  const restoredCheck = new DatabaseSync(targetDatabase, { readOnly: true }); const restoredOutboxes = restoredCheck.prepare('SELECT state,receipt_json,result_json FROM team_output_outbox WHERE project_id=?').all(targetId); assert.equal(restoredOutboxes.length, 1, 'only a safe non-terminal working continuation is retained'); assert.equal(restoredOutboxes[0].state, 'restore_republish'); assert.equal(restoredOutboxes[0].receipt_json, '{}', 'source-scope Host receipt is removed'); assert.equal(JSON.parse(restoredOutboxes[0].result_json).materialized, undefined); restoredCheck.close();
  const importedCheck = new DatabaseSync(targetDatabase, { readOnly: true }); const reboundImported = importedCheck.prepare("SELECT artifact_path FROM team_task_artifacts WHERE project_id=? AND id='imported-artifact'").get(targetId).artifact_path; importedCheck.close(); assert.match(reboundImported, new RegExp(`projects[\\\\/]${targetHash}[\\\\/]restored-imported`)); assert.equal(fs.readFileSync(reboundImported, 'utf8'), 'host-materialized-working', 'only a source-project referenced Host materialization is carried into the target private namespace');
  assert.equal(JSON.parse(fs.readFileSync(path.join(targetComponentRoot, 'output-ownership', targetHash, 'working-images.json'), 'utf8')).recovery.state, 'needs-republish', 'restored ownership is explicitly marked for target-scope republish');
  console.log('Team-retouch current project-private storage restore passed');
} finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
