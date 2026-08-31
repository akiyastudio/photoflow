const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createArchiveService } = require('../electron/services/archive-service.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');

const createTestMovePathAtomic = temporaryRoot => {
  const resolvedRoot = path.resolve(temporaryRoot);
  const assertInsideTemporaryRoot = candidate => {
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), `${candidate} must be inside the test temporary root`);
  };

  return async (source, destination) => {
    assertInsideTemporaryRoot(source);
    assertInsideTemporaryRoot(destination);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await assert.rejects(fs.promises.lstat(destination), error => error?.code === 'ENOENT', `test move destination already exists: ${destination}`);
    try {
      await fs.promises.rename(source, destination);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      await fs.promises.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
      await fs.promises.rm(source, { recursive: true });
    }
  };
};

const main = async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-archive-service-'));
  try {
    const movePathAtomic = createTestMovePathAtomic(temporaryRoot);
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
    const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const service = createArchiveService({
      backgroundTasks,
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

    const persistencePath = path.join(temporaryRoot, 'archive-tasks.json');
    const interruptedTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath });
    const interrupted = interruptedTasks.create({
      id: 'archive-resume-test', type: 'project-archive', title: '归档恢复测试', resumable: true,
      metadata: { workspacePath: workspaceRoot, projectId: row.id, projectName: row.name, archivePath },
    });
    await interrupted.waitForStart();
    interrupted.context.saveCheckpoint({ version: 1, phase: 'finalizing', expected: { fileCount: 2, bytes: 26, samples: [] } }, 90, '正在登记归档状态');
    interruptedTasks.stop();
    const restoredTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath });
    createArchiveService({ backgroundTasks: restoredTasks, movePathAtomic, readSavedConfig: () => config, workspaceRepository, writeLog: () => undefined });
    assert.strictEqual(restoredTasks.get('archive-resume-test').resumeAvailable, true, 'archive resume worker must register after restart');
    const resumedArchive = await restoredTasks.resume('archive-resume-test');
    assert.strictEqual(resumedArchive.task.state, 'completed', 'an interrupted archive must finish from its saved phase');
    restoredTasks.stop();

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

    const rearchived = await service.archiveProject(workspaceRoot, row.name);
    const resumedMoveArchivePath = rearchived.result.archivePath;
    await fs.promises.unlink(projectRoot);
    await movePathAtomic(resumedMoveArchivePath, projectRoot);
    const movePersistencePath = path.join(temporaryRoot, 'unarchive-tasks.json');
    const interruptedMoveTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath: movePersistencePath });
    const interruptedMove = interruptedMoveTasks.create({
      id: 'unarchive-resume-test', type: 'project-unarchive', title: '解档恢复测试', resumable: true,
      metadata: { workspacePath: workspaceRoot, projectId: row.id, projectName: row.name, archivePath: resumedMoveArchivePath, statusAfter: '后期中' },
    });
    await interruptedMove.waitForStart();
    interruptedMove.context.saveCheckpoint({ version: 1, phase: 'finalizing', expected: { fileCount: 2, bytes: 26 } }, 90, '正在登记移回状态');
    interruptedMoveTasks.stop();
    const restoredMoveTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath: movePersistencePath });
    createArchiveService({ backgroundTasks: restoredMoveTasks, movePathAtomic, readSavedConfig: () => config, workspaceRepository, writeLog: () => undefined });
    const resumedMove = await restoredMoveTasks.resume('unarchive-resume-test');
    assert.strictEqual(resumedMove.task.state, 'completed', 'an unarchive interrupted after its move must finish database registration');
    assert.strictEqual(row.status, '后期中');
    restoredMoveTasks.stop();
    console.log('Archive service integration tests passed.');
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
