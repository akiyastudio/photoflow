const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { registerRuntimeFolderArtifacts } = require('../electron/services/component-runtime-artifacts.cjs');
const Ajv = require('ajv');
const contract = require('../electron/contracts/schemas/component-host-api.schema.json');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-runtime-artifacts-'));
const workspace = path.join(root, 'workspace'), project = path.join(workspace, 'Project'), database = path.join(root, 'catalog.sqlite3');
const repository = path.resolve(__dirname, '..');
const python = path.join(repository, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const program = `import json, sys, uuid
sys.path.insert(0, sys.argv[1] + '/python')
import workspace_db as w
root, database, action, payload = sys.argv[2], sys.argv[3], sys.argv[4], json.loads(sys.argv[5])
db = w.connect(root, database, include_domains=True)
try:
    if action == 'setup':
        db.execute('INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)', ('project-1','Project','active','Project',1,1))
        db.commit()
        result = {'success': True}
    elif action == 'list': result = w.progress_list(root, db, payload)
    else: result = w.progress_adopt_media(root, db, payload)
    print(json.dumps(result, ensure_ascii=False))
finally: db.close()
`;
const call = (action, payload = {}) => JSON.parse(execFileSync(python, ['-c', program, repository, workspace, database, action, JSON.stringify(payload)], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } }));

const run = async () => {
  try {
    const testContract = JSON.parse(JSON.stringify(contract).replace(/#\/\$defs\//g, '#/definitions/'));
    testContract.definitions = testContract.$defs;
    delete testContract.$defs; delete testContract.$schema; delete testContract.$id;
    const validate = new Ajv({ allErrors: true }).compile(testContract);
    assert(validate({ method: 'component.runtime.execute', payload: { action: 'execute', runtimeCapability: 'fixture.runtime', arguments: [], projectArtifacts: { mode: 'transcode', mediaKind: 'video' } }, result: { operationId: '68a35cbe-40e3-4bc4-98dc-33f2fd53d7f0', result: {}, task: { state: 'completed' } } }), JSON.stringify(validate.errors));
    assert.equal(validate({ method: 'component.runtime.execute', payload: { action: 'execute', runtimeCapability: 'fixture.runtime', arguments: [], projectArtifacts: { mode: 'transcode', mediaKind: 'image' } }, result: { operationId: '68a35cbe-40e3-4bc4-98dc-33f2fd53d7f0', result: {} } }), false);
    const source = path.join(project, 'mov'), output = path.join(project, '任意导出名称');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(output);
    call('setup');
    const original = call('adopt', { projectName: 'Project', folderPath: source, mode: 'original', mediaKind: 'video' });
    let adoptionCalls = 0;
    const options = {
      policy: { mode: 'transcode', mediaKind: 'video' }, fs, path,
      result: { folderOutputs: [{ sourceFolder: source, outputFolder: output }] },
      inputs: [{ filePath: source, relativePath: 'mov', directory: true }],
      scope: { workspaceRoot: workspace, projectRoot: project }, context: { projectName: 'Project' },
      versionService: {
        listProgress: async () => call('list', { projectName: 'Project', includeMissing: true }),
        adoptMediaFolder: async (_root, payload) => { adoptionCalls += 1; return call('adopt', payload); },
      },
    };
    const linked = await registerRuntimeFolderArtifacts(options);
    assert.equal(linked.linked.length, 1);
    assert.equal(linked.linked[0].sourceProgressId, original.progressFolder.id);
    const snapshot = call('list', { projectName: 'Project', includeMissing: true });
    const derived = snapshot.progressFolders.find(item => item.id === linked.linked[0].targetProgressId);
    assert.equal(derived.nodeRole, 'artifact'); assert.equal(derived.artifactKind, 'transcode');
    const edge = snapshot.graphEdges.find(item => item.targetProgressId === derived.id);
    assert.equal(edge.sourceProgressId, original.progressFolder.id); assert.equal(edge.edgeKind, 'derived_transcode');
    assert.deepEqual(await registerRuntimeFolderArtifacts(options), linked, 'replaying the same completed output is idempotent');
    assert.equal(call('list', { projectName: 'Project', includeMissing: true }).graphEdges.length, snapshot.graphEdges.length);
    const callsBeforeInvalid = adoptionCalls;
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    await assert.rejects(registerRuntimeFolderArtifacts({ ...options, result: { folderOutputs: [{ sourceFolder: source, outputFolder: outside }] } }), /outside the project/);
    await assert.rejects(registerRuntimeFolderArtifacts({ ...options, inputs: [] }), /not an authorized input/);
    await assert.rejects(registerRuntimeFolderArtifacts({ ...options, result: { folderOutputs: [options.result.folderOutputs[0], options.result.folderOutputs[0]] } }), /more than once/);
    assert.equal(adoptionCalls, callsBeforeInvalid, 'invalid mappings cannot mutate any graph node');
    const unknown = path.join(project, 'not-registered'); fs.mkdirSync(unknown);
    const skipped = await registerRuntimeFolderArtifacts({ ...options, inputs: [{ filePath: unknown, relativePath: 'not-registered', directory: true }], result: { folderOutputs: [{ sourceFolder: unknown, outputFolder: output }] } });
    assert.deepEqual(skipped.skipped, [{ index: 0, reason: 'source-not-registered' }]);
    assert.equal(adoptionCalls, callsBeforeInvalid, 'folder names never manufacture a source relation');
    console.log('Runtime artifact graph: real database relation, nonstandard output name, replay, source authorization and output boundaries passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
run().catch(error => { console.error(error); process.exitCode = 1; });
