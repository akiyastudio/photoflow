const assert = require('node:assert');
// Plugin-owned regression test.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTeamWorkflowArtifactService } = require('../workflow-artifact.cjs');

const run = async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-team-workflow-artifacts-'));
  const logs = [];
  const service = createTeamWorkflowArtifactService({
    crypto,
    fs,
    path,
    getWorkspaceDataRoot: workspaceRoot => path.join(workspaceRoot, 'data'),
    writeLog: (...args) => logs.push(args),
  });

  try {
    const source = service.artifactPaths(temporaryRoot, '后期中', '7-21');
    for (const filePath of Object.values(source)) await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(source.manifest, JSON.stringify({ version: 2, projectName: '7-21', status: '后期中', groups: [] }), 'utf8');
    await fs.promises.writeFile(source.settings, JSON.stringify({ preferredIdentityOrder: ['person-1'] }), 'utf8');
    await fs.promises.writeFile(source.similarities, JSON.stringify({ similarities: [{ left: 'a', right: 'b' }] }), 'utf8');
    await fs.promises.mkdir(source.reviewSession, { recursive: true });
    await fs.promises.writeFile(path.join(source.reviewSession, 'return-1.jpg'), 'pending-return', 'utf8');
    await fs.promises.writeFile(path.join(source.reviewSession, 'session.json'), JSON.stringify({
      version: 1,
      id: 'review-1',
      projectName: '7-21',
      status: '后期中',
      result: { matches: [{ returnId: 'return-1', path: path.join(source.reviewSession, 'return-1.jpg') }] },
    }), 'utf8');

    const renamed = await service.migrate(temporaryRoot,
      { status: '后期中', projectName: '7-21' },
      { status: '后期中', projectName: '26-7-21' });
    assert.deepStrictEqual(renamed.map(result => result.state), ['migrated', 'migrated', 'migrated', 'migrated']);

    const destination = service.artifactPaths(temporaryRoot, '后期中', '26-7-21');
    assert.strictEqual(fs.existsSync(source.manifest), false);
    assert.strictEqual(fs.existsSync(source.settings), false);
    assert.strictEqual(fs.existsSync(source.similarities), false);
    assert.strictEqual(fs.existsSync(source.reviewSession), false);
    assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(destination.manifest, 'utf8')), {
      version: 2,
      projectName: '26-7-21',
      status: '后期中',
      groups: [],
    });
    assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(destination.settings, 'utf8')), { preferredIdentityOrder: ['person-1'] });
    const migratedReview = JSON.parse(await fs.promises.readFile(path.join(destination.reviewSession, 'session.json'), 'utf8'));
    assert.strictEqual(migratedReview.projectName, '26-7-21');
    assert.strictEqual(migratedReview.status, '后期中');
    assert.strictEqual(migratedReview.result.matches[0].path, path.join(destination.reviewSession, 'return-1.jpg'));

    const movedStatus = await service.migrate(temporaryRoot,
      { status: '后期中', projectName: '26-7-21' },
      { status: '已完成', projectName: '26-7-21' });
    assert.strictEqual(movedStatus.find(result => result.kind === 'manifest').state, 'migrated');
    assert.strictEqual(movedStatus.find(result => result.kind === 'settings').state, 'missing');
    assert.strictEqual(movedStatus.find(result => result.kind === 'reviewSession').state, 'updated');
    const completed = service.artifactPaths(temporaryRoot, '已完成', '26-7-21');
    const completedManifest = JSON.parse(await fs.promises.readFile(completed.manifest, 'utf8'));
    assert.strictEqual(completedManifest.status, '已完成');
    assert.strictEqual(fs.existsSync(destination.settings), true, 'status changes must keep name-keyed settings in place');
    assert.strictEqual(JSON.parse(await fs.promises.readFile(path.join(destination.reviewSession, 'session.json'), 'utf8')).status, '已完成');

    const conflictSource = service.artifactPaths(temporaryRoot, '后期中', 'old-name');
    const conflictDestination = service.artifactPaths(temporaryRoot, '后期中', 'occupied-name');
    await fs.promises.mkdir(path.dirname(conflictSource.settings), { recursive: true });
    await fs.promises.writeFile(conflictSource.settings, 'source', 'utf8');
    await fs.promises.writeFile(conflictDestination.settings, 'destination', 'utf8');
    const conflicted = await service.migrate(temporaryRoot,
      { status: '后期中', projectName: 'old-name' },
      { status: '后期中', projectName: 'occupied-name' });
    assert.strictEqual(conflicted.find(result => result.kind === 'settings').state, 'conflict');
    assert.strictEqual(await fs.promises.readFile(conflictSource.settings, 'utf8'), 'source');
    assert.strictEqual(await fs.promises.readFile(conflictDestination.settings, 'utf8'), 'destination');
    assert.ok(logs.some(entry => entry[1] === 'Team workflow artifact migration skipped because destination exists'));
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
};

run().then(() => console.log('Team workflow artifact migration tests passed.')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
