const assert = require('assert/strict');
// Plugin-owned regression test.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkflowManifestResolver, findOwnedWorkflowOutput, workflowManifestKey } = require('../workflow-manifest.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-manifest-'));
const writeJsonAtomic = async (target, value) => {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const pending = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(pending, JSON.stringify(value), 'utf8');
  await fs.promises.rename(pending, target);
};
const resolve = createWorkflowManifestResolver({ crypto, fs, path, writeJsonAtomic });
const storage = projectId => ({ projectId, dataPath: path.join(sandbox, projectId) });
const manifest = (projectName, status, itemCount, availableCount) => ({
  version: 2, projectName, status,
  groups: [{ week: 1, identityId: 'identity-1', items: Array.from({ length: itemCount }, (_, index) => ({
    taskId: `task-${index}`, photoId: `photo-${index % 27}`, baseVersionId: `version-${index % 27}`,
    personIndex: index + 1, relativePath: `week/item-${index}.png`, available: index < availableCount,
  })) }],
});
const seedLegacy = async (project, value) => {
  const directory = path.join(project.storage.dataPath, 'workflows');
  await fs.promises.mkdir(directory, { recursive: true });
  const legacyPath = path.join(directory, `${workflowManifestKey(crypto, `${project.context.projectStatus}\0${project.context.projectName}`)}.json`);
  await fs.promises.writeFile(legacyPath, JSON.stringify(value), 'utf8');
  return legacyPath;
};

(async () => {
  try {
    const partiallyMigratedGroup = {
      items: [
        { available: true, relativePath: '第三周/香奈乎/first.png' },
        { available: true, relativePath: '第三周/香奈乎/second.png' },
        { available: false, relativePath: '第三周/香奈乎/future.png' },
      ],
    };
    const selectedOwnership = { commitId: 'commit-2', artifactId: 'artifact-2', sha256: 'digest-2' };
    assert.deepEqual(findOwnedWorkflowOutput(partiallyMigratedGroup, {
      '团片协作/第三周/香奈乎/second.png': selectedOwnership,
      '团片协作/第三周/香奈乎/future.png': { commitId: 'future', artifactId: 'future-artifact' },
    }), {
      item: partiallyMigratedGroup.items[1],
      relativePath: '团片协作/第三周/香奈乎/second.png',
      ownership: selectedOwnership,
    }, 'a partially migrated folder opens through the first available item that actually has Host ownership');
    assert.equal(findOwnedWorkflowOutput(partiallyMigratedGroup, {}), null, 'a folder with no owned available output has no candidate before Host adoption');

    const projects = [
      { context: { projectId: 'edcf361f-64a4-4a64-b582-1dd046cd8119', projectName: '26-6-6', projectStatus: 'active' }, items: 140, available: 46 },
      { context: { projectId: '56b985d7-e022-4d35-81e2-d4a311681780', projectName: '26-7-11', projectStatus: 'active' }, items: 196, available: 25 },
      { context: { projectId: '7bf58365-75ea-4540-a996-55c4511d5848', projectName: '26-7-21', projectStatus: 'active' }, items: 296, available: 155 },
      { context: { projectId: 'small-26-8-2', projectName: '26-8-2', projectStatus: 'active' }, items: 12, available: 4 },
    ].map(project => ({ ...project, storage: storage(project.context.projectId) }));
    const legacyPaths = await Promise.all(projects.map(project => seedLegacy(project, manifest(project.context.projectName, project.context.projectStatus, project.items, project.available))));
    const migrated = await Promise.all(projects.map(project => resolve(project.storage, project.context)));
    migrated.forEach((scope, index) => {
      assert.equal(scope.source, 'legacy-status-name');
      assert.equal(scope.manifest.projectId, projects[index].context.projectId);
      assert.equal(scope.manifest.groups[0].items.length, projects[index].items);
      assert(fs.existsSync(scope.manifestPath), 'canonical manifest is copied atomically');
      assert(fs.existsSync(legacyPaths[index]), 'legacy manifest remains intact');
    });

    const priority = projects[2];
    const canonical = { ...manifest('renamed-project', 'archived', 3, 1), projectId: priority.context.projectId, marker: 'canonical-wins' };
    await writeJsonAtomic(migrated[2].manifestPath, canonical);
    assert.equal((await resolve(priority.storage, priority.context)).manifest.marker, 'canonical-wins', 'canonical storage wins over a matching legacy file and survives project rename');

    const wrong = { context: { projectId: 'wrong-target', projectName: 'same-name', projectStatus: 'active' }, storage: storage('wrong-target') };
    await seedLegacy(wrong, manifest('same-name', 'active', 2, 1));
    const wrongCanonical = path.join(wrong.storage.dataPath, 'workflows', `${workflowManifestKey(crypto, wrong.context.projectId)}.json`);
    await writeJsonAtomic(wrongCanonical, { ...manifest('other', 'active', 1, 1), projectId: 'another-project' });
    assert.equal((await resolve(wrong.storage, wrong.context)).manifest, null, 'a canonical manifest bound to another project is rejected without legacy fallback');

    const damaged = { context: { projectId: 'damaged-target', projectName: 'damaged', projectStatus: 'active' }, storage: storage('damaged-target') };
    await seedLegacy(damaged, manifest('damaged', 'active', 2, 1));
    const damagedCanonical = path.join(damaged.storage.dataPath, 'workflows', `${workflowManifestKey(crypto, damaged.context.projectId)}.json`);
    await fs.promises.writeFile(damagedCanonical, '{broken', 'utf8');
    assert.equal((await resolve(damaged.storage, damaged.context)).source, 'invalid-canonical');
    assert.equal(await fs.promises.readFile(damagedCanonical, 'utf8'), '{broken', 'damaged canonical data is never overwritten by fallback');

    const mismatch = { context: { projectId: 'mismatch-target', projectName: 'expected', projectStatus: 'active' }, storage: storage('mismatch-target') };
    const mismatchPath = await seedLegacy(mismatch, manifest('different', 'active', 1, 1));
    assert.equal((await resolve(mismatch.storage, mismatch.context)).manifest, null, 'legacy adoption requires exact top-level name and status');
    assert(fs.existsSync(mismatchPath));

    console.log('Team-retouch workflow manifest resolver tests passed');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
