const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { SELECTION_LIMITS, createSelectionService, parseSelectionKeywords } = require('../electron/services/selection-service.cjs');
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
  assert.deepStrictEqual(parseSelectionKeywords('4310.4309.4056.'), ['4310', '4309', '4056'], '英文句号分隔的纯编号必须全部识别');
  assert.deepStrictEqual(parseSelectionKeywords('4310，4309、4056;4157|4178/4181'), ['4310', '4309', '4056', '4157', '4178', '4181'], '常见中英文符号必须可以混合分隔编号');
  assert.deepStrictEqual(parseSelectionKeywords('IMG_4310.CR3、DSC-4309.JPG，4056 img_4310.cr3'), ['IMG_4310.CR3', 'DSC-4309.JPG', '4056'], '完整文件名与纯编号必须可以混输，并对文件名忽略大小写去重');
  assert.deepStrictEqual(parseSelectionKeywords('618A7394.CR3 20260818_IMG_4310.CR3'), ['618A7394.CR3', '20260818_IMG_4310.CR3'], '完整文件名必须原样保留');
  assert.deepStrictEqual(parseSelectionKeywords('12 99 IMG_ABCD'), [], '少于三位或不含末尾编号的内容必须忽略');
  assert.deepStrictEqual(parseSelectionKeywords('4310-4320'), ['4310', '4320'], '连字符只分隔端点，不展开编号范围');
  const sourceModel = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'tools', 'filename-selection-model.ts')).href);
  const sourceFolders = [{ name: 'RAW', relativePath: 'RAW' }, { name: 'MOV', relativePath: 'MOV' }, { name: 'JPG', relativePath: 'shoot/day/JPG' }];
  assert.strictEqual(sourceModel.resolveFilenameSelectionSource(sourceFolders, undefined, 'raw'), 'RAW', '图片来源必须默认匹配 RAW，且不受大小写影响');
  assert.strictEqual(sourceModel.resolveFilenameSelectionSource(sourceFolders, undefined, 'mov'), 'MOV', '视频来源必须默认匹配 MOV，且不受大小写影响');
  assert.strictEqual(sourceModel.resolveFilenameSelectionSource(sourceFolders, '', 'raw'), '', '用户必须可以关闭图片或视频中的任一来源');
  assert.strictEqual(sourceModel.resolveFilenameSelectionSource(sourceFolders, 'shoot\\day\\JPG', 'raw'), 'shoot/day/JPG', '用户选择的完整相对路径必须保留');
  assert.strictEqual(sourceModel.filenameSelectionOutputName('RAW'), '图片选片');
  assert.strictEqual(sourceModel.filenameSelectionOutputName('MOV'), '视频选片');

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
    put(projectRoot, 'RAW/618A7394.CR3');
    put(projectRoot, 'RAW/IMG_7394.JPG');
    put(projectRoot, 'shoot/day/JPG/DSC_2002.JPG');
    put(projectRoot, 'MOV/clip_3003.MOV');
    put(projectRoot, 'Mixed/still_3500.JPG');
    put(projectRoot, 'Mixed/clip_3500.MOV');

    const folders = await service.listSourceFolders(request('RAW'));
    assert(folders.folders.some(folder => folder.relativePath === 'shoot/day/JPG'), '嵌套来源应出现在文件夹列表');

    const exactFilenamePreview = await service.preflightFilename({ ...request('RAW'), mediaKind: 'image', keywords: '618A7394.CR3' });
    assert.strictEqual(exactFilenamePreview.matchedCount, 1, '完整文件名只能精确匹配同名文件');
    assert(exactFilenamePreview.items.some(item => item.sourceRelativePath === 'RAW/618A7394.CR3'));
    const exactStemPreview = await service.preflightFilename({ ...request('RAW'), mediaKind: 'image', keywords: 'IMG_7394' });
    assert.strictEqual(exactStemPreview.matchedCount, 1, '省略扩展名时必须按完整主文件名精确匹配');
    assert(exactStemPreview.items.some(item => item.sourceRelativePath === 'RAW/IMG_7394.JPG'));
    const numericPreview = await service.preflightFilename({ ...request('RAW'), mediaKind: 'image', keywords: '7394' });
    assert.strictEqual(numericPreview.matchedCount, 2, '纯编号仍应匹配具有相同末尾编号的所有媒体');

    const virtualRealpath = value => path.resolve(value);
    virtualRealpath.native = virtualRealpath;
    const virtualRoot = path.join(temporaryRoot, 'virtual-project-a');
    const virtualRootB = path.join(temporaryRoot, 'virtual-project-b');
    const wideEntries = Array.from({ length: SELECTION_LIMITS.maxDirectoriesPerTask + 5 }, (_, index) => ({
      name: `folder-${String(index).padStart(5, '0')}`,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      isFile: () => false,
    }));
    let virtualReaddirCount = 0;
    const virtualFs = {
      ...fs,
      realpathSync: virtualRealpath,
      promises: { ...fs.promises, readdir: async directory => {
        virtualReaddirCount += 1;
        return path.resolve(directory) === path.resolve(virtualRoot) ? [...wideEntries] : [];
      } },
    };
    const virtualService = createSelectionService({ ...options, fs: virtualFs });
    const collectVirtualFolders = async () => {
      const collected = [];
      let cursor;
      let last;
      do {
        last = await virtualService.listSourceFolders({ workspaceRoot, projectName: 'Virtual A', projectRoot: virtualRoot, cursor, pageSize: 999 });
        assert(last.folders.length <= SELECTION_LIMITS.sourceFolderPageSize, '单页不得超过 500 个目录');
        collected.push(...last.folders.map(folder => folder.relativePath));
        cursor = last.nextCursor;
      } while (cursor);
      return { collected, last };
    };
    const firstListing = await collectVirtualFolders();
    const secondListing = await collectVirtualFolders();
    assert.strictEqual(firstListing.collected.length, SELECTION_LIMITS.maxDirectoriesPerTask);
    assert.strictEqual(new Set(firstListing.collected).size, firstListing.collected.length, '分页不得返回重复目录');
    assert.deepStrictEqual(secondListing.collected, firstListing.collected, '相同目录的分页顺序必须稳定');
    assert.strictEqual(firstListing.last.truncated, true, '超过单任务目录上限必须明确标记 truncated');
    assert.strictEqual(virtualReaddirCount, 2, '宽目录分页不应重复 readdir');

    const crossProjectFirst = await virtualService.listSourceFolders({ workspaceRoot, projectName: 'Virtual A', projectRoot: virtualRoot, pageSize: 1 });
    await expectReject(virtualService.listSourceFolders({ workspaceRoot, projectName: 'Virtual B', projectRoot: virtualRootB, cursor: crossProjectFirst.nextCursor, pageSize: 1 }), /cursor.*当前项目/i);
    await expectReject(virtualService.listSourceFolders({ workspaceRoot, projectName: 'Virtual A', projectRoot: virtualRoot, cursor: 'forged-cursor', pageSize: 1 }), /cursor.*无效/i);

    const deepRoot = path.join(temporaryRoot, 'deep-project');
    const deepFs = {
      ...fs,
      realpathSync: virtualRealpath,
      promises: { ...fs.promises, readdir: async directory => {
        const relative = path.relative(deepRoot, directory);
        const depth = relative ? relative.split(path.sep).length : 0;
        return depth < SELECTION_LIMITS.maxDirectoryDepth + 1 ? [{ name: 'd', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }] : [];
      } },
    };
    const deepService = createSelectionService({ ...options, fs: deepFs });
    const deepResult = await deepService.listSourceFolders({ workspaceRoot, projectName: 'Deep', projectRoot: deepRoot });
    assert.strictEqual(deepResult.truncated, true, '超过最大深度必须标记 truncated');
    assert(deepResult.folders.every(folder => folder.relativePath.split('/').length <= SELECTION_LIMITS.maxDirectoryDepth));

    const linkRoot = path.join(temporaryRoot, 'link-project');
    const linkPath = path.join(linkRoot, 'outside-link');
    const linkRealpath = value => path.resolve(value) === path.resolve(linkPath) ? path.join(temporaryRoot, 'outside-link-target') : path.resolve(value);
    linkRealpath.native = linkRealpath;
    const linkFs = { ...fs, realpathSync: linkRealpath, promises: { ...fs.promises, readdir: async () => [{ name: 'outside-link', isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false }] } };
    const linkService = createSelectionService({ ...options, fs: linkFs });
    await expectReject(linkService.listSourceFolders({ workspaceRoot, projectName: 'Link', projectRoot: linkRoot }), /指向项目外部/);

    let cancelListingService;
    let cancelledReaddirCount = 0;
    const cancelListFs = { ...fs, realpathSync: virtualRealpath, promises: { ...fs.promises, readdir: async () => {
      cancelledReaddirCount += 1;
      cancelListingService.cancel('listing-cancel-001');
      return wideEntries.slice(0, 10);
    } } };
    cancelListingService = createSelectionService({ ...options, fs: cancelListFs });
    const cancelledListing = await cancelListingService.listSourceFolders({ workspaceRoot, projectName: 'Cancel list', projectRoot: virtualRoot, operationId: 'listing-cancel-001' });
    assert.strictEqual(cancelledListing.cancelled, true);
    assert.strictEqual(cancelledReaddirCount, 1, '取消后不得继续 readdir');

    mkdir(path.join(projectRoot, 'ScanLimit'));
    const excessiveFiles = Array.from({ length: SELECTION_LIMITS.maxSourceFiles + 1 }, (_, index) => ({ name: `file-${index}.jpg`, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true }));
    const fileLimitFs = { ...fs, promises: { ...fs.promises, readdir: async directory => path.resolve(directory) === path.resolve(path.join(projectRoot, 'ScanLimit')) ? excessiveFiles : [] } };
    const fileLimitService = createSelectionService({ ...options, fs: fileLimitFs });
    await expectReject(fileLimitService.preflightFilename({ ...request('ScanLimit'), keywords: '1001', operationId: 'file-limit-001' }), /selection_file_limit_exceeded.*50000/);

    let cancelScanService;
    let cancelledScanReaddirCount = 0;
    const cancelScanFs = { ...fs, promises: { ...fs.promises, readdir: async () => {
      cancelledScanReaddirCount += 1;
      cancelScanService.cancel('scan-cancel-001');
      return [];
    } } };
    cancelScanService = createSelectionService({ ...options, fs: cancelScanFs });
    const cancelledScan = await cancelScanService.preflightFilename({ ...request('ScanLimit'), keywords: '1001', operationId: 'scan-cancel-001' });
    assert.strictEqual(cancelledScan.cancelled, true);
    assert.strictEqual(cancelledScanReaddirCount, 1, '来源扫描取消后不得继续 readdir');

    const mixedImagePreview = await service.preflightFilename({ ...request('Mixed'), mediaKind: 'image', keywords: '3500' });
    const mixedVideoPreview = await service.preflightFilename({ ...request('Mixed'), mediaKind: 'video', keywords: '3500' });
    assert.strictEqual(mixedImagePreview.matchedCount, 1, '图片来源只能匹配图片和 RAW');
    assert.strictEqual(mixedImagePreview.imageCount, 1);
    assert.strictEqual(mixedImagePreview.videoCount, 0);
    assert.strictEqual(mixedVideoPreview.matchedCount, 1, '视频来源只能匹配视频');
    assert.strictEqual(mixedVideoPreview.imageCount, 0);
    assert.strictEqual(mixedVideoPreview.videoCount, 1);
    assert.notStrictEqual(mixedImagePreview.signature, mixedVideoPreview.signature, '媒体类型必须绑定到预检签名');

    const scanProgress = [];
    const rootPreview = await service.preflightFilename({ ...request('RAW'), keywords: '1001 9999', operationId: 'progress-scan-001', onProgress: progress => scanProgress.push(progress) });
    assert(scanProgress.some(progress => progress.phase === 'scanning_source' && progress.filesScanned >= 1), '来源扫描必须报告进度');
    assert.strictEqual(rootPreview.sourceFolderRelativePath, 'RAW');
    assert.strictEqual(rootPreview.targetFolderRelativePath, '图片选片');
    assert.strictEqual(rootPreview.outputFolderName, '图片选片');
    assert.strictEqual(rootPreview.matchedCount, 1);
    assert.strictEqual(rootPreview.filesToCopy, 1);
    assert.strictEqual(rootPreview.missingCount, 1);
    assert.strictEqual(rootPreview.unsupportedCount, 1);
    assert(rootPreview.items.some(item => item.status === 'unsupported'));
    assert.deepStrictEqual(rootPreview.missingKeywords, ['9999']);
    const rootCopyProgress = [];
    const first = await service.executeFilename({ ...request('RAW'), keywords: '1001 9999', expectedSignature: rootPreview.signature, operationId: 'root-copy-1001', onProgress: progress => rootCopyProgress.push(progress) });
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.copiedCount, 1);
    assert(rootCopyProgress.some(progress => progress.phase === 'copying' && progress.fileName === 'IMG_1001.CR3' && progress.fileIndex === 1 && progress.totalFiles === 1), '复制时必须恢复当前文件与数量提示');
    assert.strictEqual(rootCopyProgress.filter(progress => progress.phase === 'copying').at(-1).progress, 100, '复制提示必须报告真实完成进度');
    assert(first.items.some(item => item.status === 'copied'));
    assert(fs.existsSync(path.join(projectRoot, '图片选片', 'IMG_1001.CR3')));

    const sourceNode = versionService.nodes.find(node => node.id === first.sourceProgressId);
    const selectionNode = versionService.nodes.find(node => node.id === first.selectionProgressId);
    assert.strictEqual(sourceNode.nodeRole, 'original');
    assert.strictEqual(sourceNode.relationKind, null);
    assert.strictEqual(selectionNode.nodeRole, 'selection');
    assert.strictEqual(selectionNode.relationKind, 'auxiliary');
    assert.strictEqual(selectionNode.parentProgressId, sourceNode.id);
    assert.strictEqual(selectionNode.trackingEnabled, false);
    assert.strictEqual(selectionNode.trackingState, 'disabled');
    assert.strictEqual(selectionNode.renameFromParent, false);
    assert.strictEqual(selectionNode.copyMissingFromParent, false);
    await expectReject(service.preflightFilename({ ...request('图片选片'), keywords: '1001' }), /selection|附属分支/);

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
    const jpgSourceNode = versionService.nodes.find(node => node.id === nested.sourceProgressId);
    const jpgSelectionNode = versionService.nodes.find(node => node.id === nested.selectionProgressId);
    assert.strictEqual(jpgSourceNode.nodeRole, 'original');
    assert.strictEqual(jpgSelectionNode.nodeRole, 'selection');
    assert.strictEqual(jpgSelectionNode.parentProgressId, jpgSourceNode.id);
    assert.notStrictEqual(jpgSelectionNode.parentProgressId, sourceNode.id, 'JPG_选片不得错误连接到 RAW');
    assert.strictEqual(jpgSelectionNode.relationKind, 'auxiliary');

    const videoPreview = await service.preflightFilename({ ...request('MOV'), keywords: '3003' });
    assert.strictEqual(videoPreview.videoCount, 1);
    assert.strictEqual(videoPreview.imageCount, 0);
    const video = await service.executeFilename({ ...request('MOV'), keywords: '3003', expectedSignature: videoPreview.signature, operationId: 'video-copy-3003' });
    assert.strictEqual(video.selectionNode.mediaKind, 'video');

    put(projectRoot, 'a/RAW/A_4004.JPG');
    put(projectRoot, 'b/RAW/B_5005.JPG');
    for (const [source, keyword, operationId] of [['a/RAW', '4004', 'same-name-a'], ['b/RAW', '5005', 'same-name-b']]) {
      const preview = await service.preflightFilename({ ...request(source), keywords: keyword });
      assert.strictEqual(preview.outputFolderName, '图片选片');
      const result = await service.executeFilename({ ...request(source), keywords: keyword, expectedSignature: preview.signature, operationId });
      assert.strictEqual(result.success, true);
    }
    const sameNameSelections = versionService.nodes.filter(node => node.nodeRole === 'selection' && /[\\/]图片选片$/i.test(node.folderPath));
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
    const nodeCountBeforeConflict = versionService.nodes.length;
    const conflict = await service.preflightFilename({ ...request('Conflict'), keywords: '8008' });
    assert.strictEqual(conflict.conflictCount, 1);
    await expectReject(service.executeFilename({ ...request('Conflict'), keywords: '8008', expectedSignature: conflict.signature, operationId: 'output-conflict' }), /output_name_conflict/);
    assert.strictEqual(versionService.nodes.length, nodeCountBeforeConflict, '无效目标不得创建任何数据库节点');

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

    put(projectRoot, 'Interrupted/I_9201.JPG');
    mkdir(path.join(projectRoot, 'Interrupted_选片'));
    const interruptedMarker = path.join(projectRoot, 'Interrupted_选片.photoflow-selection-pending');
    fs.writeFileSync(interruptedMarker, JSON.stringify({ sourceFolderRelativePath: 'Interrupted', targetFolderRelativePath: 'Interrupted_选片' }));
    const interruptedPreview = await service.preflightFilename({ ...request('Interrupted'), keywords: '9201' });
    assert.strictEqual(interruptedPreview.conflictCount, 0, 'a matching empty recovery target must resume after process interruption');
    const interrupted = await service.executeFilename({ ...request('Interrupted'), keywords: '9201', expectedSignature: interruptedPreview.signature, operationId: 'interrupted-recovery' });
    assert.strictEqual(interrupted.success, true);
    assert(!fs.existsSync(interruptedMarker), 'successful node registration must release the recovery marker');

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
    assert(fs.existsSync(path.join(projectRoot, 'Fail_选片')), '复制失败后应保留已登记的恢复目标');
    assert.strictEqual(fs.readdirSync(path.join(projectRoot, 'Fail_选片')).length, 0, '失败必须回滚本次已复制文件');
    const failedSelection = versionService.nodes.find(node => node.nodeRole === 'selection' && /Fail_选片$/i.test(node.folderPath));
    assert(failedSelection, '复制开始前必须已经持久化 selection 节点');
    const retryPreview = await service.preflightFilename({ ...request('Fail'), keywords: '9001 9002' });
    const retried = await service.executeFilename({ ...request('Fail'), keywords: '9001 9002', expectedSignature: retryPreview.signature, operationId: 'failure-retry' });
    assert.strictEqual(retried.success, true);
    assert.strictEqual(retried.selectionProgressId, failedSelection.id, '重试必须复用中断前的 selection 节点');

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
    assert(fs.existsSync(path.join(projectRoot, 'Cancel_选片')), '取消后应保留可恢复的已登记目标');
    assert.strictEqual(fs.readdirSync(path.join(projectRoot, 'Cancel_选片')).length, 0, '取消必须回滚本次已复制文件');
    assert(versionService.nodes.some(node => node.nodeRole === 'selection' && /Cancel_选片$/i.test(node.folderPath)));

    const handlers = new Map();
    let capturedRequest;
    const ipcProgressEvents = [];
    const executeSelection = async value => {
      if (value.outcome === 'failed') throw new Error('injected IPC selection failure');
      if (value.outcome === 'cancelled') return { success: false, cancelled: true, operationId: value.operationId };
      return { success: true, operationId: value.operationId };
    };
    registerSelectionIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, path, fs,
      workspaceCatalogs: new Map([[workspaceRoot, { projects: [{ name: 'Project A', relative_path: 'Project A' }] }]]),
      selectionService: {
        preflightFilename: async value => { capturedRequest = value; return { success: true }; },
        listSourceFolders: async value => { value.onProgress({ operationId: 'ipc-progress', phase: 'listing_source_folders', directoriesScanned: 1 }); return { success: true, folders: [], nextCursor: null, truncated: false }; },
        executeFilename: executeSelection,
        preflightManual: async () => ({ success: true }),
        executeManual: executeSelection,
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
    const unknownFolderScan = await handlers.get('workspace-selection-source-folders')(null, outside, { pageSize: 500 });
    assert.strictEqual(unknownFolderScan.success, false, '未登记绝对路径不得成为文件夹扫描根');
    const registeredFolderScan = await handlers.get('workspace-selection-source-folders')({ sender: { send: (channel, payload) => ipcProgressEvents.push([channel, payload]) } }, projectRoot, { pageSize: 500 });
    assert.strictEqual(registeredFolderScan.success, true);
    assert.strictEqual(ipcProgressEvents[0][0], 'workspace-selection-progress', '文件夹扫描进度必须通过可取消任务通道返回');
    const executeEvent = { sender: { send: (channel, payload) => ipcProgressEvents.push([channel, payload]) } };
    for (const channel of ['workspace-selection-filename-execute', 'workspace-selection-manual-execute']) {
      for (const outcome of ['complete', 'cancelled', 'failed']) {
        const operationId = `${channel.includes('filename') ? 'filename' : 'manual'}-${outcome}`;
        const before = ipcProgressEvents.length;
        const result = await handlers.get(channel)(executeEvent, projectRoot, { operationId, outcome });
        const terminal = ipcProgressEvents.slice(before).at(-1)?.[1];
        assert.strictEqual(terminal?.operationId, operationId, `${channel} 的终态必须沿用原 operationId`);
        assert.strictEqual(terminal?.phase, outcome, `${channel} 必须发送 ${outcome} 终态`);
        assert.strictEqual(terminal?.progress, outcome === 'complete' ? 100 : 0, `${channel} 的终态进度必须规范化`);
        assert.strictEqual(result.operationId, operationId, `${channel} 必须把实际发布终态的 operationId 返回给页面`);
        assert.strictEqual(result.taskNotificationOwned, true, `${channel} 发布可见终态后必须显式移交通知所有权`);
        if (outcome === 'failed') {
          assert.strictEqual(result.success, false);
          assert.match(terminal.error, /injected IPC selection failure/);
        }
      }
    }
    const undelivered = await handlers.get('workspace-selection-manual-execute')({ sender: {} }, projectRoot, { operationId: 'manual-undelivered', outcome: 'failed' });
    assert.strictEqual(undelivered.success, false);
    assert.strictEqual(undelivered.taskNotificationOwned, undefined, '终态事件未实际发送时页面仍拥有失败反馈');

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
