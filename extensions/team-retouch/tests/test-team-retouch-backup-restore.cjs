const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureSchema } = require('../service.cjs');
const crypto = require('node:crypto');
const { restoreProjectStorage, restoreWorkspaceStorage, restoreWorkspaceBundle, restoreProjectBundle, publishWorkspacePrivateFiles, selectRestoreSource, writeRestoreReceipt } = require('../compatibility/storage-restore.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-backup-restore-'));
const sourcePath = path.join(root, 'backup', 'team-retouch.sqlite3');
const destinationPath = path.join(root, 'live', 'storage.sqlite3');
const oldWorkspace = path.join(root, 'old-workspace');
const newWorkspace = path.join(root, 'new-workspace');

const addProject = (databasePath, projectId, tag, workspaceRoot) => {
  const db = ensureSchema(databasePath); const now = 1000 + tag.charCodeAt(0);
  const photoId = `photo-${tag}`; const versionId = `version-${tag}`; const taskId = `task-${tag}`;
  db.prepare('INSERT INTO team_retouch_photos(project_id,photo_id,base_version_id,display_name,relative_path,relative_path_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(projectId, photoId, versionId, tag, `进行中/${tag}/input.jpg`, 'ready', now, now);
  db.prepare('INSERT INTO team_person_identities(project_id,id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(projectId, `identity-${tag}`, `Person ${tag}`, '#fff', now, now);
  db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,generation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, taskId, photoId, versionId, 1, tag, '{}', '{}', path.join(workspaceRoot, '进行中', tag, 'patch.jpg'), JSON.stringify({ manifestPath: path.join(workspaceRoot, '进行中', tag, 'workflow.json') }), now, now);
  db.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,task_id,completed,completion_kind,edited_patch_path,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(projectId, photoId, versionId, 1, `identity-${tag}`, taskId, 1, 'returned', path.join(workspaceRoot, '进行中', tag, 'returned.jpg'), now);
  db.prepare(`INSERT INTO team_task_stages(project_id,id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(projectId, `stage-${tag}`, taskId, 1, 1, 'complete', now, now);
  db.prepare(`INSERT INTO team_task_artifacts(project_id,id,task_id,stage_id,person_index,kind,artifact_path,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(projectId, `artifact-${tag}`, taskId, `stage-${tag}`, 1, 'returned', path.join(workspaceRoot, '进行中', tag, 'returned.jpg'), JSON.stringify({ source: path.join(workspaceRoot, '进行中', tag) }), now);
  db.prepare(`INSERT INTO team_workflow_review_confirmations(project_id,review_session_id,return_id,task_id,photo_id,base_version_id,person_index,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(projectId, `review-${tag}`, `return-${tag}`, taskId, photoId, versionId, 1, now);
  db.prepare(`INSERT INTO team_workflow_settings(project_id,settings_json,updated_at) VALUES(?,?,?)`).run(projectId, JSON.stringify({ exportRoot: path.join(workspaceRoot, '进行中', tag) }), now);
  db.prepare(`INSERT INTO team_workflow_state(project_id,generated_at,fingerprint,updated_at) VALUES(?,?,?,?)`).run(projectId, now, `workflow-${tag}`, now);
  db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run(projectId, 7);
  db.close();
};
const snapshotProject = (databasePath, projectId) => {
  const db = ensureSchema(databasePath); const result = {};
  for (const table of ['team_retouch_photos','team_person_identities','team_patch_tasks','team_person_assignments','team_task_stages','team_task_artifacts','team_workflow_review_confirmations','team_workflow_settings','team_workflow_state']) result[table] = db.prepare(`SELECT * FROM ${table} WHERE project_id=? ORDER BY rowid`).all(projectId);
  db.close(); return JSON.stringify(result);
};

try {
  assert.equal(selectRestoreSource([{ format: 'legacy-domain-v1', path: 'old' }, { format: 'component-storage-v1', path: 'current' }]).path, 'current', 'current component storage wins when a transition backup contains both sources');
  assert.equal(selectRestoreSource([{ format: 'component-storage-v99', path: 'unknown' }]), undefined, 'unknown storage formats are never guessed or opened');
  addProject(sourcePath, 'project-a', 'A', oldWorkspace);
  addProject(sourcePath, 'project-b', 'B', oldWorkspace);
  addProject(destinationPath, 'project-a', 'X', newWorkspace);
  addProject(destinationPath, 'project-b', 'Y', newWorkspace);
  let guardDb = ensureSchema(destinationPath);
  guardDb.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('guard-a', 'project-a', 1, 0, 1);
  guardDb.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('guard-b', 'project-b', 1, 0, 1);
  guardDb.close();
  const untouchedBefore = snapshotProject(destinationPath, 'project-b');
  const payload = {
    schemaVersion: 1, operationId: 'restore-a', mode: 'project',
    sourceWorkspace: { root: oldWorkspace, dataRoot: path.join(oldWorkspace, '.photoflow') },
    targetWorkspace: { root: newWorkspace, dataRoot: path.join(newWorkspace, '.photoflow') },
    project: { id: 'project-a', sourceRelativePath: '进行中/A', targetRelativePath: '进行中/A' },
  };
  const restored = restoreProjectStorage({ sourcePath, destinationPath, payload, ensureSchema });
  assert.equal(restored.status, 'committed');
  assert.equal(snapshotProject(destinationPath, 'project-b'), untouchedBefore, 'restoring A must not change any B row');
  let db = ensureSchema(destinationPath);
  assert.equal(db.prepare("SELECT name FROM team_person_identities WHERE project_id='project-a'").get().name, 'Person A');
  assert.equal(db.prepare("SELECT completion_kind FROM team_person_assignments WHERE project_id='project-a'").get().completion_kind, 'returned');
  assert.equal(db.prepare("SELECT fingerprint FROM team_workflow_state WHERE project_id='project-a'").get().fingerprint, 'workflow-A');
  assert.ok(db.prepare("SELECT artifact_path FROM team_task_artifacts WHERE project_id='project-a'").get().artifact_path.startsWith(newWorkspace));
  assert.ok(JSON.parse(db.prepare("SELECT generation_json FROM team_patch_tasks WHERE project_id='project-a'").get().generation_json).manifestPath.startsWith(newWorkspace));
  assert.equal(db.prepare("SELECT count(*) AS count FROM team_revision_guards WHERE project_id='project-a'").get().count, 0, 'project restore clears stale guards for its target');
  assert.equal(db.prepare("SELECT count(*) AS count FROM team_revision_guards WHERE project_id='project-b'").get().count, 1, 'project restore preserves guards belonging to other projects');
  db.close();
  assert.equal(restoreProjectStorage({ sourcePath, destinationPath, payload, ensureSchema }).status, 'already-committed');
  const committedState = snapshotProject(destinationPath, 'project-a');
  assert.throws(() => restoreProjectStorage({ sourcePath, destinationPath, payload: { ...payload, operationId: 'restore-a-fail' }, ensureSchema, fault: 'after-delete' }), /injected/);
  assert.equal(snapshotProject(destinationPath, 'project-a'), committedState, 'failed import must roll back target deletion and inserts');

  const workspaceDestination = path.join(root, 'workspace-live', 'storage.sqlite3');
  addProject(workspaceDestination, 'obsolete', 'Z', newWorkspace);
  guardDb = ensureSchema(workspaceDestination);
  guardDb.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('guard-obsolete', 'obsolete', 1, 0, 1);
  guardDb.close();
  const workspace = restoreWorkspaceStorage({ sourcePath, destinationPath: workspaceDestination, payload: { ...payload, operationId: 'restore-workspace', mode: 'workspace', project: undefined }, ensureSchema });
  assert.equal(workspace.status, 'committed');
  db = ensureSchema(workspaceDestination);
  assert.deepEqual(db.prepare('SELECT project_id FROM team_retouch_photos ORDER BY project_id').all().map(row => row.project_id), ['project-a', 'project-b']);
  assert.equal(db.prepare("SELECT name FROM team_person_identities WHERE project_id='project-b'").get().name, 'Person B');
  assert.equal(db.prepare("SELECT fingerprint FROM team_workflow_state WHERE project_id='project-b'").get().fingerprint, 'workflow-B');
  assert.equal(db.prepare('SELECT count(*) AS count FROM team_revision_guards').get().count, 0, 'workspace restore clears all transient request guards');
  db.close();
  assert.equal(restoreWorkspaceStorage({ sourcePath, destinationPath: workspaceDestination, payload: { ...payload, operationId: 'restore-workspace', mode: 'workspace', project: undefined }, ensureSchema }).status, 'already-committed');

  // A project represented only by workflow state must not disappear from a
  // legacy full-workspace restore merely because it has no photos or people.
  db = ensureSchema(sourcePath);
  db.prepare('INSERT INTO team_workflow_state(project_id,generated_at,fingerprint,updated_at) VALUES(?,?,?,?)').run('workflow-only', 5, 'workflow-only-state', 5);
  db.close();
  restoreWorkspaceStorage({ sourcePath, destinationPath: workspaceDestination, payload: { ...payload, operationId: 'restore-workspace-2', mode: 'workspace', project: undefined }, ensureSchema });
  db = ensureSchema(workspaceDestination);
  assert.equal(db.prepare("SELECT fingerprint FROM team_workflow_state WHERE project_id='workflow-only'").get().fingerprint, 'workflow-only-state');
  db.close();

  const walSource = path.join(root, 'wal-source', 'storage.sqlite3');
  const walDestination = path.join(root, 'wal-live', 'storage.sqlite3');
  const walDb = ensureSchema(walSource);
  walDb.exec('PRAGMA wal_autocheckpoint=0');
  walDb.prepare('INSERT INTO team_workflow_state(project_id,generated_at,fingerprint,updated_at) VALUES(?,?,?,?)').run('wal-project', 9, 'committed-in-wal', 9);
  assert.ok(fs.existsSync(`${walSource}-wal`), 'fixture keeps committed data in a WAL sidecar');
  restoreProjectStorage({ sourcePath: walSource, destinationPath: walDestination, payload: { ...payload, operationId: 'restore-wal', project: { id: 'wal-project' } }, ensureSchema });
  db = ensureSchema(walDestination);
  assert.equal(db.prepare("SELECT fingerprint FROM team_workflow_state WHERE project_id='wal-project'").get().fingerprint, 'committed-in-wal');
  db.close(); walDb.close();

  // A current-format workspace source is a full opaque component tree. The
  // component owns publishing its private files and rewriting embedded paths.
  const privateSource = path.join(root, 'backup', 'workflow-jobs', 'job.json');
  const binarySource = path.join(root, 'backup', 'media', 'photo-a', 'version-a', 'analysis', 'mask.bin');
  const binarySourceB = path.join(root, 'backup', 'media', 'photo-b', 'version-b', 'analysis', 'mask.bin');
  fs.mkdirSync(path.dirname(privateSource), { recursive: true });
  fs.mkdirSync(path.dirname(binarySource), { recursive: true });
  fs.mkdirSync(path.dirname(binarySourceB), { recursive: true });
  fs.writeFileSync(privateSource, JSON.stringify({ manifest: path.join(oldWorkspace, '进行中', 'A', 'workflow.json'), nested: { root: oldWorkspace } }));
  fs.writeFileSync(binarySource, Buffer.from([0, 1, 2, 3, 255]));
  fs.writeFileSync(binarySourceB, Buffer.from('source-project-b'));
  const sourceProjectHash = crypto.createHash('sha256').update('project-a').digest('hex');
  const targetProjectHash = crypto.createHash('sha256').update('project-restored').digest('hex');
  const legacyWorkflowHash = crypto.createHash('sha256').update('active\0A').digest('hex');
  const legacyReviewHash = crypto.createHash('sha256').update('A').digest('hex');
  const unrelatedWorkflowHash = crypto.createHash('sha256').update('active\0B').digest('hex');
  const unrelatedReviewHash = crypto.createHash('sha256').update('B').digest('hex');
  const canonicalLedgerSource = path.join(root, 'backup', 'output-ownership', sourceProjectHash, 'working-images.json');
  const legacyWorkflowSource = path.join(root, 'backup', 'workflows', `${legacyWorkflowHash}.json`);
  const workflowContentSource = path.join(root, 'backup', 'workflow-content', legacyWorkflowHash, 'manifest.json');
  const legacyReviewSession = path.join(root, 'backup', 'workflow-return-reviews', legacyReviewHash, 'session.json');
  const legacyReviewImage = path.join(root, 'backup', 'workflow-return-reviews', legacyReviewHash, 'return.png');
  const unrelatedWorkflowSource = path.join(root, 'backup', 'workflows', `${unrelatedWorkflowHash}.json`);
  const unrelatedReviewSession = path.join(root, 'backup', 'workflow-return-reviews', unrelatedReviewHash, 'session.json');
  fs.mkdirSync(path.dirname(canonicalLedgerSource), { recursive: true }); fs.writeFileSync(canonicalLedgerSource, JSON.stringify({ '进行中/A/input_裁切/a.png': { artifactId: 'a' } }));
  fs.mkdirSync(path.dirname(legacyWorkflowSource), { recursive: true }); fs.writeFileSync(legacyWorkflowSource, JSON.stringify({ version: 2, projectId: 'project-a', projectName: 'A', status: 'active', groups: [{ id: 'a', items: [] }] }));
  fs.mkdirSync(path.dirname(workflowContentSource), { recursive: true }); fs.writeFileSync(workflowContentSource, JSON.stringify({ projectId: 'project-a', projectName: 'A', status: 'active', root: oldWorkspace }));
  fs.mkdirSync(path.dirname(legacyReviewSession), { recursive: true }); fs.writeFileSync(legacyReviewSession, JSON.stringify({ version: 2, projectId: 'project-a', projectName: 'A', status: 'active', result: { matches: [{ path: path.join(oldWorkspace, '进行中', 'A', 'return.png') }] } }));
  fs.writeFileSync(legacyReviewImage, Buffer.from('legacy-review-a'));
  fs.mkdirSync(path.dirname(unrelatedWorkflowSource), { recursive: true }); fs.writeFileSync(unrelatedWorkflowSource, JSON.stringify({ version: 2, projectId: 'project-b', projectName: 'B', status: 'active', groups: [{ id: 'b', items: [] }] }));
  fs.mkdirSync(path.dirname(unrelatedReviewSession), { recursive: true }); fs.writeFileSync(unrelatedReviewSession, JSON.stringify({ version: 2, projectId: 'project-b', projectName: 'B', status: 'active', result: { matches: [] } }));
  const currentDataPath = path.join(root, 'current-tree-live');
  const currentDatabasePath = path.join(currentDataPath, 'storage.sqlite3');
  addProject(currentDatabasePath, 'obsolete-current', 'Q', newWorkspace);
  const sources = [
    { format: 'component-storage-v1', relativePath: 'team-retouch/storage.sqlite3', path: sourcePath },
    ...[
      ['team-retouch/workflow-jobs/job.json', privateSource],
      ['team-retouch/media/photo-A/version-A/analysis/mask.bin', binarySource],
      ['team-retouch/media/photo-B/version-B/analysis/mask.bin', binarySourceB],
      [`team-retouch/output-ownership/${sourceProjectHash}/working-images.json`, canonicalLedgerSource],
      [`team-retouch/workflows/${legacyWorkflowHash}.json`, legacyWorkflowSource],
      [`team-retouch/workflow-content/${legacyWorkflowHash}/manifest.json`, workflowContentSource],
      [`team-retouch/workflow-return-reviews/${legacyReviewHash}/session.json`, legacyReviewSession],
      [`team-retouch/workflow-return-reviews/${legacyReviewHash}/return.png`, legacyReviewImage],
      [`team-retouch/workflows/${unrelatedWorkflowHash}.json`, unrelatedWorkflowSource],
      [`team-retouch/workflow-return-reviews/${unrelatedReviewHash}/session.json`, unrelatedReviewSession],
    ].map(([relativePath, file]) => ({ format: 'component-storage-opaque-v1', relativePath, path: file, size: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
  ];
  const projectTreeDataPath = path.join(root, 'project-tree-live');
  const projectTreeDatabasePath = path.join(projectTreeDataPath, 'storage.sqlite3');
  addProject(projectTreeDatabasePath, 'project-restored', 'X', newWorkspace);
  addProject(projectTreeDatabasePath, 'project-b', 'Y', newWorkspace);
  const targetB = path.join(projectTreeDataPath, 'media', 'photo-b', 'version-b', 'analysis', 'mask.bin');
  fs.mkdirSync(path.dirname(targetB), { recursive: true }); fs.writeFileSync(targetB, Buffer.from('target-project-b-preserved'));
  const projectBundlePayload = { ...payload, sources, operationId: 'restore-project-tree', project: { ...payload.project, id: 'project-restored', sourceId: 'project-a', sourceName: 'A', sourceStatus: 'active', targetName: 'Restored', targetStatus: 'archived' } };
  const projectBundle = restoreProjectBundle({ source: sources[0], sources, destinationPath: projectTreeDatabasePath, destinationDataPath: projectTreeDataPath, payload: projectBundlePayload, ensureSchema });
  assert(projectBundle.consumedPaths.includes('team-retouch/media/photo-A/version-A/analysis/mask.bin'));
  assert(!projectBundle.consumedPaths.includes('team-retouch/media/photo-B/version-B/analysis/mask.bin'));
  assert.deepEqual(fs.readFileSync(path.join(projectTreeDataPath, 'media', 'photo-a', 'version-a', 'analysis', 'mask.bin')), Buffer.from([0, 1, 2, 3, 255]));
  assert.equal(fs.readFileSync(targetB, 'utf8'), 'target-project-b-preserved', 'project restore leaves another project private bytes unchanged');
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectTreeDataPath, 'output-ownership', targetProjectHash, 'working-images.json'), 'utf8'))['进行中/A/input_裁切/a.png'].artifactId, 'a');
  const restoredWorkflow = JSON.parse(fs.readFileSync(path.join(projectTreeDataPath, 'workflows', `${targetProjectHash}.json`), 'utf8'));
  assert.deepEqual({ projectId: restoredWorkflow.projectId, projectName: restoredWorkflow.projectName, status: restoredWorkflow.status }, { projectId: 'project-restored', projectName: 'Restored', status: 'archived' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projectTreeDataPath, 'workflow-content', targetProjectHash, 'manifest.json'), 'utf8')),
    { projectId: 'project-restored', projectName: 'Restored', status: 'archived', root: newWorkspace });
  const restoredReview = JSON.parse(fs.readFileSync(path.join(projectTreeDataPath, 'workflow-return-reviews', targetProjectHash, 'session.json'), 'utf8'));
  assert.deepEqual({ projectId: restoredReview.projectId, projectName: restoredReview.projectName, status: restoredReview.status }, { projectId: 'project-restored', projectName: 'Restored', status: 'archived' });
  assert.ok(restoredReview.result.matches[0].path.startsWith(newWorkspace));
  assert.equal(fs.readFileSync(path.join(projectTreeDataPath, 'workflow-return-reviews', targetProjectHash, 'return.png'), 'utf8'), 'legacy-review-a');
  assert(!projectBundle.consumedPaths.includes(`team-retouch/workflows/${unrelatedWorkflowHash}.json`), 'another project legacy workflow is not claimed');
  assert(!projectBundle.consumedPaths.includes(`team-retouch/workflow-return-reviews/${unrelatedReviewHash}/session.json`), 'another project legacy review is not claimed');

  const targetA = path.join(projectTreeDataPath, 'media', 'photo-a', 'version-a', 'analysis', 'mask.bin');
  fs.writeFileSync(targetA, Buffer.from('target-a-before-failure'));
  assert.throws(() => restoreProjectBundle({ source: sources[0], sources, destinationPath: projectTreeDatabasePath, destinationDataPath: projectTreeDataPath, payload: { ...projectBundlePayload, operationId: 'restore-project-tree-fail' }, ensureSchema, fault: 'after-private-backup' }), /injected/);
  assert.equal(fs.readFileSync(targetA, 'utf8'), 'target-a-before-failure', 'a publish failure after destination backup restores the current file');
  assert.equal(fs.readFileSync(targetB, 'utf8'), 'target-project-b-preserved');
  const bundlePayload = { ...payload, operationId: 'restore-current-tree', mode: 'workspace', project: undefined, sources };
  const bundled = restoreWorkspaceBundle({ source: sources[0], sources, destinationPath: currentDatabasePath, destinationDataPath: currentDataPath, payload: bundlePayload, ensureSchema });
  assert.deepEqual(new Set(bundled.consumedPaths), new Set(sources.map(item => item.relativePath)));
  assert.deepEqual(fs.readFileSync(path.join(currentDataPath, 'media', 'photo-a', 'version-a', 'analysis', 'mask.bin')), Buffer.from([0, 1, 2, 3, 255]));
  const restoredJob = JSON.parse(fs.readFileSync(path.join(currentDataPath, 'workflow-jobs', 'job.json'), 'utf8'));
  assert.ok(restoredJob.manifest.startsWith(newWorkspace));
  assert.equal(restoredJob.nested.root, newWorkspace);

  const beforeFailedBundle = snapshotProject(currentDatabasePath, 'project-a');
  fs.writeFileSync(path.join(currentDataPath, 'workflow-jobs', 'job.json'), JSON.stringify({ preserved: true }));
  assert.throws(() => restoreWorkspaceBundle({ source: sources[0], sources, destinationPath: currentDatabasePath, destinationDataPath: currentDataPath, payload: { ...bundlePayload, operationId: 'restore-current-tree-fail' }, ensureSchema, fault: 'after-private-file' }), /injected/);
  assert.equal(snapshotProject(currentDatabasePath, 'project-a'), beforeFailedBundle, 'private file failure rolls the database restore back');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(currentDataPath, 'workflow-jobs', 'job.json'), 'utf8')), { preserved: true }, 'private file failure rolls prior target files back');

  const actualOutsideRoot = path.join(root, 'junction-outside'); const linkedStorageRoot = path.join(root, 'linked-storage');
  fs.mkdirSync(actualOutsideRoot);
  try {
    fs.symlinkSync(actualOutsideRoot, linkedStorageRoot, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => publishWorkspacePrivateFiles({ sources: [sources[1]], destinationDataPath: linkedStorageRoot, payload }), /重解析|链接/, 'a junction component root cannot redirect restore writes outside Host storage');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
    console.log(`Team-retouch junction escape fixture skipped: ${error.code}`);
  }
  const largeManifestPath = path.join(root, 'large-source-manifest.json');
  fs.writeFileSync(largeManifestPath, '{}');
  const largeSources = Array.from({ length: 20_000 }, (_unused, index) => ({
    sourceKey: `component-storage\0team-retouch/private/${String(index).padStart(5, '0')}-${'x'.repeat(96)}.bin`,
    relativePath: `team-retouch/private/${String(index).padStart(5, '0')}-${'x'.repeat(96)}.bin`,
  }));
  const largeResult = writeRestoreReceipt({
    operationId: 'large-receipt', mode: 'project', sourceManifestPath: largeManifestPath,
    sourceManifestSha256: 'a'.repeat(64),
  }, { schema: 'component-backup-restore-sources-v1' }, largeSources, {
    status: 'committed', consumedPaths: [],
    pathDispositions: largeSources.map(source => ({ path: source.relativePath, action: 'intentionally-skipped', reason: 'other-project' })),
  });
  assert.ok(fs.statSync(largeResult.receiptPath).size > 2 * 1024 * 1024, 'large disposition receipts remain in the authenticated stage file');
  assert.ok(Buffer.byteLength(JSON.stringify(largeResult)) < 4096, 'large disposition receipts never cross the JSON-line RPC boundary');
  assert.equal(largeResult.dispositionCount, 20_000);
  const customContract = {
    keyField: 'entryId', dispositionField: 'outcome', destinationField: 'publishedAs', reasonField: 'because', messageField: 'detail',
    actions: { applied: 'used', skipped: 'ignored', hostPreserved: 'host-kept' },
  };
  const customReceipt = writeRestoreReceipt({ operationId: 'custom-contract', mode: 'project', sourceManifestPath: largeManifestPath, sourceManifestSha256: 'b'.repeat(64) },
    { schema: 'component-backup-restore-sources-v1', receiptContract: customContract },
    [{ sourceKey: 'source-1', relativePath: 'team-retouch/old.json' }],
    { status: 'committed', consumedPaths: ['team-retouch/old.json'], consumedPathMappings: [{ path: 'team-retouch/old.json', destinationRelativePath: 'team-retouch/new.json' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(customReceipt.receiptPath, 'utf8')).dispositions[0], { entryId: 'source-1', outcome: 'used', publishedAs: 'team-retouch/new.json' }, 'receipt serialization follows the authenticated manifest contract rather than hard-coded field/action names');
  console.log('Team-retouch component-owned backup restore tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
