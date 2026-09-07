const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureSchema } = require('../service.cjs');
const { createHostSimulator } = require('./host-simulator.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-current-generation-'));
const databasePath = path.join(root, 'storage.sqlite3');
const generation = { version: 2, sourceWidth: 1200, sourceHeight: 1800, workWidth: 600, workHeight: 900, sourceCropWidth: 600, sourceCropHeight: 900, fullFrame: false, sourceCoverage: 0.25, requiresManualCrop: false, exceedsWorkTileEdge: false };
let db = ensureSchema(databasePath);
db.exec("INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES('photo','project','base',1,1)");
db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,generation_json,created_at,updated_at) VALUES('project','task','photo','base',1,'Person','{}','{}','working.png','[{"personIndex":1}]',?,1,1)`).run(JSON.stringify(generation));
db.close(); db = null;
const simulator = createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'project' },
  capabilities: { 'component.storage': () => ({ dataPath: root, databasePath, projectId: 'project', ownership: 'component-private' }) },
});
(async () => {
  try {
    const snapshot = await simulator.request('team.project.get.v1');
    assert.deepEqual(snapshot.photos[0].tasks[0].generation, generation);
    assert.equal(snapshot.photos[0].tasks[0].requiresManualCrop, false);
    assert.equal(snapshot.photos[0].tasks[0].patchPath, undefined);
    for (const value of ['{}', 'null', '[]', 'invalid-json', '{"version":1}', '{"version":3}']) {
      db = ensureSchema(databasePath);
      db.prepare("UPDATE team_patch_tasks SET generation_json=? WHERE id='task'").run(value);
      db.close(); db = null;
      await assert.rejects(simulator.request('team.project.get.v1'), /generation 格式无效/);
      db = ensureSchema(databasePath);
      assert.equal(db.prepare("SELECT generation_json FROM team_patch_tasks WHERE id='task'").get().generation_json, value, 'reads cannot infer or rewrite an unsupported generation');
      db.close(); db = null;
    }
    console.log('Team-retouch strict current generation RPC tests passed');
  } finally {
    db?.close(); await simulator.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('team-current-generation-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
