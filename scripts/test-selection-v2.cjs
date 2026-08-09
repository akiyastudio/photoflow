const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSelectionService } = require('../electron/services/selection-service.cjs');
const { registerSelectionIpc } = require('../electron/modules/selection-ipc.cjs');

const mkdir = value => fs.mkdirSync(value, { recursive: true });
const put = (root, relativePath, contents = relativePath) => {
  const target = path.join(root, ...relativePath.split('/'));
  mkdir(path.dirname(target));
  fs.writeFileSync(target, contents);
  return target;
};

const createVersionService = () => {
  const nodes = [];
  let nextId = 1;
  return {
    nodes,
    async listProgress() { return { success: true, progressFolders: nodes }; },
    async registerProgress(_workspaceRoot, request) {
      let node = request.progressId ? nodes.find(item => item.id === request.progressId) : null;
      if (!node) {
        node = { id: `node-${nextId++}` };
        nodes.push(node);
      }
      Object.assign(node, request, {
        folderMissing: false,
        trackingEnabled: Boolean(request.trackingEnabled),
        renameFromParent: Boolean(request.renameFromParent),
        copyMissingFromParent: Boolean(request.copyMissingFromParent),
      });
      return { success: true, progressFolder: node };
    },
  };
};

const copyExclusive = async (source, destination) => {
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
};

const expectReject = async (promise, pattern) => {
  await assert.rejects(promise, pattern);
};

const run = async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-selection-v2-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const projectRoot = path.join(workspaceRoot, 'Project A');
  mkdir(projectRoot);
  const versionService = createVersionService();
  const options = {
    fs, crypto, copyFileAtomic: copyExclusive, versionService,
    imageExtensions: new Set(['.jpg', '.jpeg', '.png']),
    rawExtensions: new Set(['.cr3', '.nef']),
    videoExtensions: new Set(['.mov', '.mp4']),
  };
  const service = createSelectionService(options);
  const request = sourceFolderRelativePath => ({ workspaceRoot, projectName: 'Project A', projectRoot, sourceFolderRelativePath });

  try {
    put(projectRoot, 'RAW/IMG_1001.CR3');
    put(projectRoot, 'RAW/note_1001.txt');
    put(projectRoot, 'shoot/day/JPG/DSC_2002.JPG');
    put(projectRoot, 'MOV/clip_3003.MOV');

    const folders = await service.listSourceFolders(request('RAW'));
    assert(folders.folders.some(folder => folder.relativePath === 'shoot/day/JPG'), '嵌套来源应出现在文件夹列表');

    const rootPreview = await service.preflightFilename({ ...request('RAW'), keywords: '1001 9999' });
    assert.strictEqual(rootPreview.sourceFolderRelativePath, 'RAW');
    assert.strictEqual(rootPreview.targetFolderRelativePath, 'RAW_选片');
    assert.strictEqual(rootPreview.outputFolderName, 'RAW_选片');
    assert.strictEqual(rootPreview.matchedCount, 1);
    assert.strictEqual(rootPreview.filesToCopy, 1);
    assert.strictEqual(rootPreview.missingCount, 1);
    assert.strictEqual(rootPreview.unsupportedCount, 1);
    assert(rootPreview.items.some(item => item.status === 'unsupported'));
    assert.deepStrictEqual(rootPreview.missingKeywords, ['9999']);
    const first = await service.executeFilename({ ...request('RAW'), keywords: '1001 9999', expectedSignature: rootPreview.signature, operationId: 'root-copy-1001' });
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.copiedCount, 1);
    assert(first.items.some(item => item.status === 'copied'));
    assert(fs.existsSync(path.join(projectRoot, 'RAW_选片', 'IMG_1001.CR3')));

    const sourceNode = versionService.nodes.find(node => node.id === first.sourceProgressId);
    const selectionNode = versionService.nodes.find(node => node.id === first.selectionProgressId);
    assert.strictEqual(sourceNode.nodeRole, 'original');
    assert.strictEqual(sourceNode.relationKind, null);
    assert.strictEqual(selectionNode.nodeRole, 'selection');
    assert.strictEqual(selectionNode.relationKind, 'auxiliary');
    assert.strictEqual(selectionNode.parentProgressId, sourceNode.id);
    assert.strictEqual(selectionNode.trackingEnabled, false);
    assert.strictEqual(selectionNode.renameFromParent, false);
    assert.strictEqual(selectionNode.copyMissingFromParent, false);

    put(projectRoot, 'RAW/IMG_1002.CR3');
    const repeatedPreview = await service.preflightFilename({ ...request('RAW'), keywords: '1001 1002' });
    assert.strictEqual(repeatedPreview.existingCount, 1);
    assert(repeatedPreview.items.some(item => item.status === 'skipped_existing'));
    assert.strictEqual(repeatedPreview.filesToCopy, 1);
    const repeated = await service.executeFilename({ ...request('RAW'), keywords: '1001 1002', expectedSignature: repeatedPreview.signature, operationId: 'repeat-copy-1002' });
    assert.strictEqual(repeated.selectionProgressId, first.selectionProgressId, '重复选片必须复用 selection 节点');
    assert.strictEqual(versionService.nodes.filter(node => node.nodeRole === 'selection' && node.parentProgressId === sourceNode.id).length, 1);

    const nestedPreview = await service.preflightFilename({ ...request('shoot/day/JPG'), keywords: '2002' });
    assert.strictEqual(nestedPreview.targetFolderRelativePath, 'shoot/day/JPG_选片');
    const nested = await service.executeFilename({ ...request('shoot/day/JPG'), keywords: '2002', expectedSignature: nestedPreview.signature, operationId: 'nested-copy-2002' });
    assert.strictEqual(nested.success, true);

    const videoPreview = await service.preflightFilename({ ...request('MOV'), keywords: '3003' });
    assert.strictEqual(videoPreview.videoCount, 1);
    assert.strictEqual(videoPreview.imageCount, 0);
    const video = await service.executeFilename({ ...request('MOV'), keywords: '3003', expectedSignature: videoPreview.signature, operationId: 'video-copy-3003' });
    assert.strictEqual(video.selectionNode.mediaKind, 'video');

    put(projectRoot, 'a/RAW/A_4004.JPG');
    put(projectRoot, 'b/RAW/B_5005.JPG');
    for (const [source, keyword, operationId] of [['a/RAW', '4004', 'same-name-a'], ['b/RAW', '5005', 'same-name-b']]) {
      const preview = await service.preflightFilename({ ...request(source), keywords: keyword });
      assert.strictEqual(preview.outputFolderName, 'RAW_选片');
      const result = await service.executeFilename({ ...request(source), keywords: keyword, expectedSignature: preview.signature, operationId });
      assert.strictEqual(result.success, true);
    }
    const sameNameSelections = versionService.nodes.filter(node => node.nodeRole === 'selection' && /[\\/]RAW_选片$/i.test(node.folderPath));
    assert.strictEqual(sameNameSelections.length, 3);
    assert.strictEqual(new Set(sameNameSelections.map(node => node.folderPath.toLocaleLowerCase())).size, 3);

    put(projectRoot, 'Other/not-owned_6006.JPG');
    await expectReject(service.preflightManual({ ...request('RAW'), relativePaths: ['Other/not-owned_6006.JPG'] }), /不属于来源文件夹/);
    const manualPreview = await service.preflightManual({ ...request('RAW'), relativePaths: ['RAW/IMG_1001.CR3'] });
    assert.strictEqual(manualPreview.existingCount, 1, '手动选片应复用相同服务和无覆盖规则');
    await expectReject(service.preflightFilename({ ...request('../outside'), keywords: '1001' }), /越界|相对路径/);
    await expectReject(service.preflightFilename({ ...request(path.resolve(projectRoot, 'RAW')), keywords: '1001' }), /相对路径/);

    put(projectRoot, 'Stale/S_7007.JPG');
    const stalePreview = await service.preflightFilename({ ...request('Stale'), keywords: '7007' });
    fs.appendFileSync(path.join(projectRoot, 'Stale', 'S_7007.JPG'), 'changed');
    await expectReject(service.executeFilename({ ...request('Stale'), keywords: '7007', expectedSignature: stalePreview.signature, operationId: 'stale-signature' }), /预检结果已经过期/);
    assert(!fs.existsSync(path.join(projectRoot, 'Stale_选片')));

    mkdir(path.join(projectRoot, 'Conflict'));
    put(projectRoot, 'Conflict/C_8008.JPG');
    mkdir(path.join(projectRoot, 'Conflict_选片'));
    const conflict = await service.preflightFilename({ ...request('Conflict'), keywords: '8008' });
    assert.strictEqual(conflict.conflictCount, 1);
    await expectReject(service.executeFilename({ ...request('Conflict'), keywords: '8008', expectedSignature: conflict.signature, operationId: 'output-conflict' }), /output_name_conflict/);

    const outside = path.join(temporaryRoot, 'outside');
    mkdir(outside);
    let externalLinkCreated = false;
    try {
      fs.symlinkSync(outside, path.join(projectRoot, 'ExternalLink'), process.platform === 'win32' ? 'junction' : 'dir');
      externalLinkCreated = true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }
    if (externalLinkCreated) await expectReject(service.preflightFilename({ ...request('ExternalLink'), keywords: '1001' }), /项目外部/);

    put(projectRoot, 'Fail/F_9001.JPG');
    put(projectRoot, 'Fail/F_9002.JPG');
    const failPreview = await service.preflightFilename({ ...request('Fail'), keywords: '9001 9002' });
    let copyCount = 0;
    const failingService = createSelectionService({ ...options, copyFileAtomic: async (source, destination) => {
      copyCount += 1;
      if (copyCount === 2) throw new Error('injected copy failure');
      await copyExclusive(source, destination);
    } });
    await expectReject(failingService.executeFilename({ ...request('Fail'), keywords: '9001 9002', expectedSignature: failPreview.signature, operationId: 'failure-rollback' }), /injected copy failure/);
    assert(!fs.existsSync(path.join(projectRoot, 'Fail_选片')), '复制失败必须回滚本次创建内容');

    put(projectRoot, 'Cancel/C_9101.JPG');
    put(projectRoot, 'Cancel/C_9102.JPG');
    const cancelPreview = await service.preflightFilename({ ...request('Cancel'), keywords: '9101 9102' });
    let cancellingService;
    let cancelCopies = 0;
    cancellingService = createSelectionService({ ...options, copyFileAtomic: async (source, destination) => {
      await copyExclusive(source, destination);
      cancelCopies += 1;
      if (cancelCopies === 1) assert.strictEqual(cancellingService.cancel('cancel-rollback'), true);
    } });
    const cancelled = await cancellingService.executeFilename({ ...request('Cancel'), keywords: '9101 9102', expectedSignature: cancelPreview.signature, operationId: 'cancel-rollback' });
    assert.strictEqual(cancelled.cancelled, true);
    assert(!fs.existsSync(path.join(projectRoot, 'Cancel_选片')), '取消必须回滚本次创建内容');

    const handlers = new Map();
    let capturedRequest;
    registerSelectionIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, path, fs,
      workspaceCatalogs: new Map([[workspaceRoot, { projects: [{ name: 'Project A', relative_path: 'Project A' }] }]]),
      selectionService: {
        preflightFilename: async value => { capturedRequest = value; return { success: true }; },
        listSourceFolders: async () => ({ success: true, folders: [] }),
        executeFilename: async () => ({ success: true }),
        preflightManual: async () => ({ success: true }),
        executeManual: async () => ({ success: true }),
        cancel: () => false,
      },
    });
    const ipcResult = await handlers.get('workspace-selection-filename-preflight')(null, projectRoot, {
      workspaceRoot: outside, projectRoot: outside, projectName: 'attacker', sourceFolderRelativePath: 'RAW', keywords: '1001',
    });
    assert.strictEqual(ipcResult.success, true);
    assert.strictEqual(capturedRequest.workspaceRoot, workspaceRoot, 'renderer 不能覆盖可信 workspaceRoot');
    assert.strictEqual(capturedRequest.projectRoot, projectRoot, 'renderer 不能覆盖可信 projectRoot');
    assert.strictEqual(capturedRequest.projectName, 'Project A', 'renderer 不能覆盖可信 projectName');
    const unknownProject = await handlers.get('workspace-selection-filename-preflight')(null, outside, {});
    assert.strictEqual(unknownProject.success, false);

    console.log('selection V2 behavior tests passed');
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    assert(resolvedTemporaryRoot.startsWith(`${resolvedSystemTemp}${path.sep}`));
    fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
