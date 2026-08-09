const path = require('path');

const normalizeRelativePath = value => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) throw new Error('必须选择项目内相对路径');
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('相对路径包含越界片段');
  return segments.join('/');
};

const filenameSelectionKey = fileName => path.parse(fileName).name.match(/(\d{3,})$/)?.[1] || '';
const parseSelectionKeywords = values => {
  const matches = String(Array.isArray(values) ? values.join(' ') : values || '').match(/[A-Za-z0-9_.]+/g) || [];
  return [...new Set(matches.map(token => token.match(/(\d{3,})(?:\.[A-Za-z0-9]+)?$/)?.[1] || '').filter(Boolean))];
};

const createSelectionService = ({ fs, crypto, copyFileAtomic, versionService, imageExtensions, rawExtensions, videoExtensions }) => {
  const activeOperations = new Map();
  const mediaKind = filePath => {
    const extension = path.extname(filePath).toLocaleLowerCase();
    if (videoExtensions.has(extension)) return 'video';
    if (imageExtensions.has(extension) || rawExtensions.has(extension)) return 'image';
    return '';
  };
  const comparable = value => path.resolve(value).toLocaleLowerCase();
  const inside = (parent, candidate, allowSame = false) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return (allowSame && !relative) || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const resolveProjectEntry = (projectRoot, relativePath, { directory = false } = {}) => {
    const normalized = normalizeRelativePath(relativePath);
    const projectReal = fs.realpathSync.native(projectRoot);
    const candidate = path.resolve(projectRoot, ...normalized.split('/'));
    if (!inside(projectRoot, candidate)) throw new Error('选择路径超出项目范围');
    if (!fs.existsSync(candidate)) throw new Error(`项目内路径不存在：${normalized}`);
    const real = fs.realpathSync.native(candidate);
    if (!inside(projectReal, real)) throw new Error('快捷方式或重解析目录指向项目外部');
    const stat = fs.statSync(candidate);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(directory ? '来源必须是项目内文件夹' : '选择项必须是媒体文件');
    return { normalized, path: candidate, real, projectReal };
  };
  const targetForSource = (projectRoot, source) => {
    const outputName = `${path.basename(source.path)}_选片`;
    const targetPath = path.join(path.dirname(source.path), outputName);
    const targetRelativePath = path.relative(projectRoot, targetPath).replace(/\\/g, '/');
    const parentReal = fs.realpathSync.native(path.dirname(targetPath));
    if (!inside(source.projectReal, parentReal, true)) throw new Error('输出位置的父目录指向项目外部');
    if (fs.existsSync(targetPath)) {
      const targetReal = fs.realpathSync.native(targetPath);
      if (!inside(source.projectReal, targetReal)) throw new Error('选片输出快捷方式或重解析目录指向项目外部');
      if (!fs.statSync(targetPath).isDirectory()) throw new Error('output_name_conflict：输出名称已被文件占用');
    }
    return { outputName, targetPath, targetRelativePath };
  };
  const listFiles = async source => {
    const files = [];
    const queue = [source.path];
    while (queue.length) {
      const directory = queue.pop();
      const directoryReal = fs.realpathSync.native(directory);
      if (!inside(source.real, directoryReal, true)) throw new Error('来源子目录指向来源文件夹外部');
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) queue.push(candidate);
        else if (entry.isFile()) files.push(candidate);
      }
    }
    return files.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  };
  const progressContext = async (workspaceRoot, projectName, source, target) => {
    const listed = await versionService.listProgress(workspaceRoot, projectName, true);
    const nodes = listed.progressFolders || [];
    const sourceNode = nodes.find(node => comparable(node.folderPath) === comparable(source.path) && !node.folderMissing);
    if (sourceNode?.nodeRole === 'selection' || sourceNode?.relationKind === 'auxiliary') throw new Error('selection/auxiliary 节点不能作为新的选片来源');
    const targetNode = nodes.find(node => comparable(node.folderPath) === comparable(target.targetPath));
    const sourceSelections = sourceNode ? nodes.filter(node => node.nodeRole === 'selection' && node.parentProgressId === sourceNode.id) : [];
    let outputConflict = '';
    if (fs.existsSync(target.targetPath) && (!targetNode || !sourceNode || targetNode.nodeRole !== 'selection' || targetNode.parentProgressId !== sourceNode.id)) {
      outputConflict = 'output_name_conflict';
    }
    if (sourceSelections.some(node => comparable(node.folderPath) !== comparable(target.targetPath))) outputConflict = 'output_name_conflict';
    return { nodes, sourceNode, targetNode, outputConflict };
  };
  const planFromFiles = async ({ workspaceRoot, projectName, projectRoot, sourceFolderRelativePath, files, keywords = [], missingKeywords = [], unsupportedPaths = [] }) => {
    const source = resolveProjectEntry(projectRoot, sourceFolderRelativePath, { directory: true });
    const target = targetForSource(projectRoot, source);
    const context = await progressContext(workspaceRoot, projectName, source, target);
    const candidates = [];
    const destinationGroups = new Map();
    for (const filePath of files) {
      const kind = mediaKind(filePath);
      if (!kind) continue;
      const sourceRelativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
      const relativeInsideSource = path.relative(source.path, filePath);
      if (!inside(source.path, filePath)) throw new Error(`媒体不属于来源文件夹：${sourceRelativePath}`);
      const destination = path.join(target.targetPath, relativeInsideSource);
      const item = {
        sourcePath: filePath,
        sourceRelativePath,
        relativeInsideSource: relativeInsideSource.replace(/\\/g, '/'),
        destination,
        destinationRelativePath: path.relative(projectRoot, destination).replace(/\\/g, '/'),
        name: path.basename(filePath), kind,
        size: fs.statSync(filePath).size,
        modifiedAt: fs.statSync(filePath).mtimeMs,
      };
      candidates.push(item);
      const key = comparable(destination);
      if (!destinationGroups.has(key)) destinationGroups.set(key, []);
      destinationGroups.get(key).push(item);
    }
    const conflicts = [];
    const existing = [];
    const copyItems = [];
    for (const group of destinationGroups.values()) {
      if (group.length > 1) conflicts.push(...group.map(item => item.destinationRelativePath));
      else if (fs.existsSync(group[0].destination)) existing.push(group[0]);
      else copyItems.push(group[0]);
    }
    if (context.outputConflict) conflicts.unshift(target.targetRelativePath);
    const existingKeys = new Set(existing.map(item => comparable(item.destination)));
    const conflictKeys = new Set(conflicts.map(item => comparable(path.join(projectRoot, item))));
    const items = candidates.map(item => ({
      sourceRelativePath: item.sourceRelativePath,
      destinationRelativePath: item.destinationRelativePath,
      mediaKind: item.kind,
      status: conflictKeys.has(comparable(item.destination)) ? 'destination_collision' : existingKeys.has(comparable(item.destination)) ? 'skipped_existing' : 'planned',
    })).concat(unsupportedPaths.map(sourceRelativePath => ({ sourceRelativePath, status: 'unsupported' })));
    const kinds = new Set(candidates.map(item => item.kind));
    const detectedMediaKind = kinds.size > 1 ? 'mixed' : [...kinds][0] || context.sourceNode?.mediaKind || 'image';
    if (context.sourceNode && context.sourceNode.mediaKind !== 'mixed' && kinds.size && !kinds.has(context.sourceNode.mediaKind)) {
      throw new Error('选片媒体类型与来源节点不兼容');
    }
    const signaturePayload = {
      sourceFolderRelativePath: source.normalized,
      targetRelativePath: target.targetRelativePath,
      keywords,
      unsupportedPaths,
      outputConflict: context.outputConflict,
      files: candidates.map(item => ({ source: item.sourceRelativePath, destination: item.destinationRelativePath, size: item.size, modifiedAt: item.modifiedAt })),
      existing: existing.map(item => item.destinationRelativePath),
    };
    const signature = crypto.createHash('sha256').update(JSON.stringify(signaturePayload)).digest('hex');
    return {
      source, target, context, candidates, copyItems, existing, conflicts,
      keywords, missingKeywords, unsupportedPaths, detectedMediaKind, signature,
      summary: {
        success: true,
        sourceFolderRelativePath: source.normalized,
        targetFolderRelativePath: target.targetRelativePath,
        outputFolderName: target.outputName,
        matchedCount: candidates.length,
        filesToCopy: copyItems.length,
        existingCount: existing.length,
        conflictCount: conflicts.length,
        missingCount: missingKeywords.length,
        unsupportedCount: unsupportedPaths.length,
        imageCount: candidates.filter(item => item.kind === 'image').length,
        videoCount: candidates.filter(item => item.kind === 'video').length,
        totalBytes: copyItems.reduce((sum, item) => sum + item.size, 0),
        existingPaths: existing.slice(0, 50).map(item => item.destinationRelativePath),
        conflictPaths: conflicts.slice(0, 50),
        missingKeywords,
        unsupportedPaths,
        items,
        signature,
      },
    };
  };
  const preflightFilename = async request => {
    const source = resolveProjectEntry(request.projectRoot, request.sourceFolderRelativePath, { directory: true });
    const keywords = parseSelectionKeywords(request.keywords);
    if (!keywords.length) throw new Error('没有可用的文件名编号');
    const allFiles = await listFiles(source);
    const byKeyword = new Map();
    for (const filePath of allFiles) {
      const key = filenameSelectionKey(path.basename(filePath));
      if (!key) continue;
      if (!byKeyword.has(key)) byKeyword.set(key, []);
      byKeyword.get(key).push(filePath);
    }
    const files = [];
    const unsupportedPaths = [];
    const missingKeywords = [];
    for (const keyword of keywords) {
      const matches = byKeyword.get(keyword) || [];
      const supported = matches.filter(filePath => mediaKind(filePath));
      const unsupported = matches.filter(filePath => !mediaKind(filePath));
      unsupportedPaths.push(...unsupported.map(filePath => path.relative(request.projectRoot, filePath).replace(/\\/g, '/')));
      if (!matches.length) missingKeywords.push(keyword);
      else files.push(...supported);
    }
    return planFromFiles({ ...request, files: [...new Set(files)], keywords, missingKeywords, unsupportedPaths: [...new Set(unsupportedPaths)] });
  };
  const listSourceFolders = async request => {
    const projectReal = fs.realpathSync.native(request.projectRoot);
    const folders = [];
    const queue = [request.projectRoot];
    while (queue.length) {
      const directory = queue.pop();
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.photoflow-')) continue;
        const candidate = path.join(directory, entry.name);
        const real = fs.realpathSync.native(candidate);
        if (!inside(projectReal, real)) continue;
        const relativePath = path.relative(request.projectRoot, candidate).replace(/\\/g, '/');
        folders.push({ name: entry.name, relativePath });
        queue.push(candidate);
      }
    }
    folders.sort((left, right) => left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true, sensitivity: 'base' }));
    return { success: true, folders };
  };
  const preflightManual = async request => {
    const source = resolveProjectEntry(request.projectRoot, request.sourceFolderRelativePath, { directory: true });
    if (!Array.isArray(request.relativePaths) || !request.relativePaths.length) throw new Error('没有选择媒体文件');
    const files = request.relativePaths.map(relativePath => {
      const item = resolveProjectEntry(request.projectRoot, relativePath);
      if (!inside(source.path, item.path)) throw new Error(`媒体不属于来源文件夹：${item.normalized}`);
      if (!mediaKind(item.path)) throw new Error(`不支持的媒体文件：${item.normalized}`);
      return item.path;
    });
    return planFromFiles({ ...request, files: [...new Set(files)] });
  };
  const ensureNodes = async (request, plan) => {
    let { sourceNode, targetNode, nodes } = plan.context;
    const sourceDisplayName = nodes.some(node => node.id !== sourceNode?.id && node.displayName.toLocaleLowerCase() === path.basename(plan.source.path).toLocaleLowerCase())
      ? plan.source.normalized : path.basename(plan.source.path);
    if (!sourceNode) {
      sourceNode = (await versionService.registerProgress(request.workspaceRoot, {
        projectName: request.projectName,
        mediaKind: plan.detectedMediaKind,
        versionKey: `source-${crypto.createHash('sha256').update(plan.source.normalized.toLocaleLowerCase()).digest('hex').slice(0, 20)}`,
        displayName: sourceDisplayName,
        folderPath: plan.source.path,
        nodeRole: 'original', relationKind: null, parentProgressId: null,
        trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled',
      })).progressFolder;
    }
    if (!sourceNode || sourceNode.nodeRole === 'selection') throw new Error('无法登记选片来源节点');
    if (targetNode && (targetNode.nodeRole !== 'selection' || targetNode.parentProgressId !== sourceNode.id)) throw new Error('output_name_conflict');
    const selectionDisplayName = nodes.some(node => node.id !== targetNode?.id && node.displayName.toLocaleLowerCase() === plan.target.outputName.toLocaleLowerCase())
      ? plan.target.targetRelativePath : plan.target.outputName;
    targetNode = (await versionService.registerProgress(request.workspaceRoot, {
      projectName: request.projectName,
      ...(targetNode ? { progressId: targetNode.id } : {}),
      mediaKind: sourceNode.mediaKind || plan.detectedMediaKind,
      versionKey: `selection-${sourceNode.id}`,
      displayName: selectionDisplayName,
      folderPath: plan.target.targetPath,
      nodeRole: 'selection', relationKind: 'auxiliary', parentProgressId: sourceNode.id,
      trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled',
    })).progressFolder;
    return { sourceNode, selectionNode: targetNode };
  };
  const executePlan = async (request, buildPlan) => {
    const operationId = String(request.operationId || crypto.randomUUID());
    if (!/^[0-9a-z-]{8,128}$/i.test(operationId) || activeOperations.has(operationId)) throw new Error('选片 operationId 无效或重复');
    const job = { cancelled: false };
    activeOperations.set(operationId, job);
    const createdFiles = [];
    const createdDirectories = [];
    try {
      const plan = await buildPlan();
      if (!request.expectedSignature || request.expectedSignature !== plan.signature) throw new Error('预检结果已经过期，请重新预检');
      if (plan.context.outputConflict || plan.conflicts.length) throw new Error('output_name_conflict：选片输出名称或文件目标存在冲突');
      if (!fs.existsSync(plan.target.targetPath)) {
        await fs.promises.mkdir(plan.target.targetPath, { recursive: false });
        createdDirectories.push(plan.target.targetPath);
      }
      for (const item of plan.copyItems) {
        if (job.cancelled) throw Object.assign(new Error('选片任务已取消'), { code: 'TASK_CANCELLED' });
        const destinationDirectory = path.dirname(item.destination);
        if (!fs.existsSync(destinationDirectory)) {
          await fs.promises.mkdir(destinationDirectory, { recursive: true });
          createdDirectories.push(destinationDirectory);
        }
        if (fs.existsSync(item.destination)) throw new Error(`目标文件已存在：${item.destinationRelativePath}`);
        await copyFileAtomic(item.sourcePath, item.destination, { isCancelled: () => job.cancelled });
        createdFiles.push(item.destination);
      }
      if (job.cancelled) throw Object.assign(new Error('选片任务已取消'), { code: 'TASK_CANCELLED' });
      const nodes = await ensureNodes(request, plan);
      return {
        ...plan.summary, success: true, operationId, copiedCount: createdFiles.length,
        items: plan.summary.items.map(item => item.status === 'planned' ? { ...item, status: 'copied' } : item),
        sourceProgressId: nodes.sourceNode.id, selectionProgressId: nodes.selectionNode.id,
        selectionNode: nodes.selectionNode,
      };
    } catch (error) {
      for (const filePath of createdFiles.reverse()) await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      for (const directory of [...new Set(createdDirectories)].sort((left, right) => right.length - left.length)) {
        await fs.promises.rmdir(directory).catch(() => undefined);
      }
      if (job.cancelled || error?.code === 'TASK_CANCELLED') return { success: false, cancelled: true, operationId, error: '选片任务已取消' };
      throw error;
    } finally {
      activeOperations.delete(operationId);
    }
  };

  return {
    listSourceFolders,
    preflightFilename: async request => (await preflightFilename(request)).summary,
    executeFilename: request => executePlan(request, () => preflightFilename(request)),
    preflightManual: async request => (await preflightManual(request)).summary,
    executeManual: request => executePlan(request, () => preflightManual(request)),
    cancel: operationId => {
      const job = activeOperations.get(String(operationId || ''));
      if (!job) return false;
      job.cancelled = true;
      return true;
    },
  };
};

module.exports = { createSelectionService, filenameSelectionKey, normalizeRelativePath, parseSelectionKeywords };
