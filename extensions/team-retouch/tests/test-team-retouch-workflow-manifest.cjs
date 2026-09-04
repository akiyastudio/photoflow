const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkflowManifestResolver, findOwnedWorkflowOutput, verifiedWorkflowManifest, workflowManifestKey } = require('../workflow-manifest.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-manifest-'));
const resolve = createWorkflowManifestResolver({ crypto, fs, path });
const current = projectId => ({ version: 2, projectId, groups: [{ week: 1, identityId: 'identity', items: [{ taskId: 'task', photoId: 'photo', baseVersionId: 'version', personIndex: 1, relativePath: 'week/item.png', available: true }] }] });

(async () => {
  try {
    const projectId = 'project-a'; const storage = { projectId, dataPath: path.join(sandbox, 'data') };
    const missing = await resolve(storage, { projectId });
    assert.equal(missing.source, 'missing'); assert.equal(missing.manifest, null);
    fs.mkdirSync(path.dirname(missing.manifestPath), { recursive: true });
    fs.writeFileSync(missing.manifestPath, JSON.stringify(current(projectId)));
    const loaded = await resolve(storage, { projectId });
    assert.equal(loaded.source, 'current'); assert.deepEqual(loaded.manifest, current(projectId));
    assert.equal(verifiedWorkflowManifest(current('other'), { projectId }), null, 'another project binding fails closed');
    assert.equal(verifiedWorkflowManifest({ ...current(projectId), version: 1 }, { projectId }), null, 'non-current manifest version fails closed');
    assert.equal(verifiedWorkflowManifest({ ...current(projectId), projectId: '' }, { projectId }), null, 'unbound data is never inferred from names or status');
    assert.equal(workflowManifestKey(crypto, projectId), crypto.createHash('sha256').update(projectId).digest('hex'));
    const ownership = { commitId: 'commit', artifactId: 'artifact', sha256: 'digest' };
    assert.deepEqual(findOwnedWorkflowOutput(loaded.manifest.groups[0], { '团片协作/week/item.png': ownership }), { item: loaded.manifest.groups[0].items[0], relativePath: '团片协作/week/item.png', ownership });
    fs.writeFileSync(missing.manifestPath, '{broken');
    const invalid = await resolve(storage, { projectId });
    assert.equal(invalid.source, 'invalid-current'); assert.equal(invalid.manifest, null);
    console.log('Team-retouch strict current workflow manifest tests passed');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
