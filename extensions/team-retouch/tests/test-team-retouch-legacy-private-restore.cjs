const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureSchema } = require('../service.cjs');
const { restoreProjectBundle } = require('../compatibility/storage-restore.cjs');
const { createHostSimulator } = require('./host-simulator.cjs');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-legacy-private-'));
const sourceDataPath = path.join(root, 'snapshot', 'team-retouch');
const targetDataPath = path.join(root, 'live', 'team-retouch');
const sourceDatabase = path.join(sourceDataPath, 'storage.sqlite3');
const targetDatabase = path.join(targetDataPath, 'storage.sqlite3');
const sourceId = 'project-a'; const targetId = 'project-restored';
const sourceName = 'A-old'; const targetName = 'A-new';
const sourceStatus = 'active'; const targetStatus = 'archived';
const sourceWorkflowKey = hash(`${sourceStatus}\0${sourceName}`);
const sourceReviewKey = hash(sourceName); const targetKey = hash(targetId);

const opaque = (relativePath, filePath) => ({
  format: 'component-storage-opaque-v1', relativePath, path: filePath,
  size: fs.statSync(filePath).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
});

(async () => {
  try {
    let db = ensureSchema(sourceDatabase);
    db.prepare('INSERT INTO team_workflow_state(project_id,generated_at,fingerprint,updated_at) VALUES(?,?,?,?)').run(sourceId, 1065, 'legacy-workflow', 1065);
    db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run(sourceId, 3);
    db.close();
    db = ensureSchema(targetDatabase);
    db.prepare('INSERT INTO team_workflow_state(project_id,generated_at,fingerprint,updated_at) VALUES(?,?,?,?)').run(targetId, 1, 'old-target', 1);
    db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run(targetId, 1);
    db.close();

    const manifestPath = path.join(sourceDataPath, 'workflows', `${sourceWorkflowKey}.json`);
    const contentPath = path.join(sourceDataPath, 'workflow-content', sourceWorkflowKey, 'group.json');
    const sessionPath = path.join(sourceDataPath, 'workflow-return-reviews', sourceReviewKey, 'session.json');
    const imagePath = path.join(sourceDataPath, 'workflow-return-reviews', sourceReviewKey, 'return.png');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(contentPath), { recursive: true });
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, projectId: sourceId, projectName: sourceName, status: sourceStatus, generatedAt: 1065, groups: [{ id: 'legacy', items: [{ photoId: 'p', baseVersionId: 'v', personIndex: 1, available: true, relativePath: 'group/item' }] }] }));
    fs.writeFileSync(contentPath, JSON.stringify({ projectId: sourceId, projectName: sourceName, status: sourceStatus, sourceRoot: path.join(root, 'old-workspace') }));
    fs.writeFileSync(sessionPath, JSON.stringify({ version: 2, id: 'review-a', projectId: sourceId, projectName: sourceName, status: sourceStatus, result: { matches: [{ returnId: 'r', accepted: false }] } }));
    fs.writeFileSync(imagePath, 'review-a');
    const otherTarget = path.join(targetDataPath, 'workflow-return-reviews', hash('project-b'), 'session.json');
    fs.mkdirSync(path.dirname(otherTarget), { recursive: true }); fs.writeFileSync(otherTarget, 'other-project-bytes');
    const oldTargetManifest = path.join(targetDataPath, 'workflows', `${targetKey}.json`);
    fs.mkdirSync(path.dirname(oldTargetManifest), { recursive: true }); fs.writeFileSync(oldTargetManifest, 'old-target-manifest');

    const sources = [
      { format: 'component-storage-v1', relativePath: 'team-retouch/storage.sqlite3', path: sourceDatabase },
      opaque(`team-retouch/workflows/${sourceWorkflowKey}.json`, manifestPath),
      opaque(`team-retouch/workflow-content/${sourceWorkflowKey}/group.json`, contentPath),
      opaque(`team-retouch/workflow-return-reviews/${sourceReviewKey}/session.json`, sessionPath),
      opaque(`team-retouch/workflow-return-reviews/${sourceReviewKey}/return.png`, imagePath),
    ];
    const payload = {
      schemaVersion: 1, operationId: 'legacy-private', mode: 'project', sources,
      sourceWorkspace: { root: path.join(root, 'old-workspace'), dataRoot: path.join(root, 'old-workspace', '.photoflow') },
      targetWorkspace: { root: path.join(root, 'new-workspace'), dataRoot: path.join(root, 'new-workspace', '.photoflow') },
      project: { id: targetId, sourceId, sourceName, sourceStatus, targetName, targetStatus },
    };
    assert.throws(() => restoreProjectBundle({ source: sources[0], sources, destinationPath: targetDatabase, destinationDataPath: targetDataPath, payload: { ...payload, operationId: 'legacy-private-fault' }, ensureSchema, fault: 'after-private-file' }), /injected/);
    assert.equal(fs.readFileSync(oldTargetManifest, 'utf8'), 'old-target-manifest', 'legacy remap failure restores the prior canonical manifest');
    assert.equal(fs.readFileSync(otherTarget, 'utf8'), 'other-project-bytes', 'legacy remap failure leaves another project unchanged');

    const result = restoreProjectBundle({ source: sources[0], sources, destinationPath: targetDatabase, destinationDataPath: targetDataPath, payload, ensureSchema });
    assert.equal(result.status, 'committed');
    const canonicalManifest = JSON.parse(fs.readFileSync(oldTargetManifest, 'utf8'));
    assert.deepEqual({ projectId: canonicalManifest.projectId, projectName: canonicalManifest.projectName, status: canonicalManifest.status }, { projectId: targetId, projectName: targetName, status: targetStatus });
    assert.equal(fs.readFileSync(path.join(targetDataPath, 'workflow-return-reviews', targetKey, 'return.png'), 'utf8'), 'review-a');
    assert.equal(fs.readFileSync(otherTarget, 'utf8'), 'other-project-bytes');
    const repeated = restoreProjectBundle({ source: sources[0], sources, destinationPath: targetDatabase, destinationDataPath: targetDataPath, payload, ensureSchema });
    assert.equal(repeated.status, 'already-committed');

    const simulator = createHostSimulator({
      service: path.join(__dirname, '..', 'service.cjs'),
      context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: targetId, projectName: targetName, projectStatus: targetStatus },
      capabilities: { 'component.storage': () => ({ apiVersion: 7, dataPath: targetDataPath, databasePath: targetDatabase, projectId: targetId, ownership: 'component-private' }) },
    });
    try {
      const project = await simulator.request('team.project.get.v1');
      assert.equal(project.workflowGenerated, true, 'the production workflow resolver reads the remapped canonical legacy manifest');
      const review = await simulator.request('team.workflow.return-review.get.v1');
      assert.equal(review.review.reviewSessionId, 'review-a', 'the production review service reads the remapped legacy review session');
    } finally { simulator.close(); }
    console.log('Team-retouch legacy private workflow/review restore tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
