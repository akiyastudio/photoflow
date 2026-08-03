const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createArchiveService } = require('../electron/services/archive-service.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { movePathAtomic } = require('../electron/services/file-transfer-service.cjs');

const main = async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-archive-service-'));
  try {
    const workspaceRoot = path.join(temporaryRoot, 'workspace');
    const projectRoot = path.join(workspaceRoot, '示例项目');
    const archiveRoot = path.join(temporaryRoot, 'archive');
    await fs.promises.mkdir(path.join(projectRoot, '修图'), { recursive: true });
    await fs.promises.mkdir(archiveRoot, { recursive: true });
    await fs.promises.writeFile(path.join(workspaceRoot, '.photoflow-workspace-id'), 'workspace-test-id\n', 'utf8');
    await fs.promises.writeFile(path.join(projectRoot, '原片.jpg'), 'original-photo', 'utf8');
    await fs.promises.writeFile(path.join(projectRoot, '修图', '版本一.jpg'), 'edited-photo', 'utf8');

    const row = { id: 'project-1', name: '示例项目', status: '后期中', relative_path: '示例项目', extra_json: '{}', is_deleted: 0, availability: 'available' };
    const workspaceRepository = {
      load: async () => ({ projects: [row] }),
      syncCatalog: async () => ({ projects: [row] }),
      archiveProject: async (_root, payload) => {
        row.status = '已归档';
        row.extra_json = JSON.stringify({ archive: { path: payload.archivePath, verifiedAt: payload.verifiedAt, fileCount: payload.fileCount, bytes: payload.bytes } });
      },
      unarchiveProject: async (_root, payload) => {
        row.status = payload.status;
        row.extra_json = '{}';
      },
    };
    const config = { archive: { enabled: true, targetPath: archiveRoot } };
    const service = createArchiveService({
      backgroundTasks: createBackgroundTaskService({ eventBus: new EventEmitter() }),
      movePathAtomic,
      readSavedConfig: () => config,
      workspaceRepository,
      writeLog: () => undefined,
    });

    const archived = await service.archiveProject(workspaceRoot, row.name);
    assert.strictEqual(archived.task.state, 'completed');
    const archivePath = JSON.parse(row.extra_json).archive.path;
    assert.ok((await fs.promises.lstat(projectRoot)).isSymbolicLink(), 'workspace entry must become a directory link');
    assert.strictEqual(await fs.promises.readFile(path.join(projectRoot, '原片.jpg'), 'utf8'), 'original-photo');
    assert.strictEqual(await fs.promises.readFile(path.join(archivePath, '修图', '版本一.jpg'), 'utf8'), 'edited-photo');
    assert.strictEqual(row.status, '已归档');

    const disconnectedRoot = `${archiveRoot}-offline`;
    await fs.promises.rename(archiveRoot, disconnectedRoot);
    assert.strictEqual(fs.existsSync(projectRoot), false, 'the directory link must naturally become unavailable while the archive disk is offline');
    await fs.promises.rename(disconnectedRoot, archiveRoot);
    assert.strictEqual(fs.existsSync(projectRoot), true, 'the project must reconnect when the archive disk returns');

    const movedBack = await service.moveBack(workspaceRoot, row.name, '后期中');
    assert.strictEqual(movedBack.task.state, 'completed');
    assert.ok((await fs.promises.stat(projectRoot)).isDirectory());
    assert.strictEqual((await fs.promises.lstat(projectRoot)).isSymbolicLink(), false);
    assert.strictEqual(fs.existsSync(archivePath), false);
    assert.strictEqual(row.status, '后期中');
    assert.deepStrictEqual(JSON.parse(row.extra_json), {});
    console.log('Archive service integration tests passed.');
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
