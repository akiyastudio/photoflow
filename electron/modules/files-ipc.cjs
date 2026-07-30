const { isProtectedProjectFolderName, isProtectedProjectFolderPath } = require('../services/protected-project-folder.cjs');

const registerFileOperationsIpc = context => {
  const { Array, Boolean, BrowserWindow, CANCELLED_CODE, Date, Error, IMAGE_EXTENSIONS, Math, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, activeProjectFileOperations, app, assertDiskSpace, assertExistingInside, assertInside, cancelMediaTrackingScan, capturePathIdentity, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, crypto, ensureWorkspace, fileOperationState, fs, getProjectPath, ipcMain, movePathAtomic, nativeImage, path, process, pushUndoOperation, readSystemFileClipboard, recycleBinService, releaseWorkspaceWatchPath, removeCopiedSources, removeCreatedPasteTargets, samePathIdentity, screen, suppressWorkspaceWatchPath, throwIfCancelled, uniqueDestination, workspaceRepository, writeLog, writeSystemFileClipboard } = context;

  ipcMain.handle('workspace-file-details', async (_event, workspacePath, status, projectName, relativePaths = []) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requested = Array.isArray(relativePaths) ? relativePaths.slice(0, 500) : [];
      const details = (await Promise.all(requested.map(async relativePath => {
        try {
          const filePath = assertInside(root, path.resolve(root, relativePath), '文件路径', true);
          const safePath = assertExistingInside(root, filePath, '文件路径', true);
          const stat = await fs.promises.stat(safePath);
          return { relativePath: path.relative(root, safePath), size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs };
        } catch { return null; }
      }))).filter(Boolean);
      return { success: true, details };
    } catch (error) { return { success: false, details: [], error: error.message || String(error) }; }
  });
  
  ipcMain.handle('workspace-cancel-file-operation', async (_event, operationId) => {
    const job = activeProjectFileOperations.get(operationId);
    if (!job || job.finishing) return { success: false, error: job?.finishing ? '文件已复制完成，正在整理源文件' : '操作已结束' };
    job.cancelled = true;
    return { success: true };
  });
  
  ipcMain.on('workspace-start-file-drag', async (event, workspacePath, status, projectName, relativePaths = []) => {
    let validatedRelativePaths = [];
    try {
      if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.length > 500) throw new Error('没有可拖动的文件');
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const sources = Array.from(new Set(relativePaths.map(relativePath => {
        if (typeof relativePath !== 'string' || !relativePath) throw new Error('无效的文件路径');
        const source = path.resolve(root, relativePath);
        if (source === root || !source.startsWith(root + path.sep)) throw new Error('文件不在当前项目中');
        if (!fs.existsSync(source)) throw new Error(`文件不存在：${path.basename(source)}`);
        return source;
      })));
      validatedRelativePaths = sources.map(source => path.relative(root, source));
  
      let icon = nativeImage.createEmpty();
      try {
        icon = await app.getFileIcon(sources[0], { size: 'normal' });
      } catch (error) {
        writeLog('warn', 'Unable to create native file drag icon', error);
      }
      if (event.sender.isDestroyed()) return;
      event.sender.startDrag({ file: sources[0], files: sources, icon });
      writeLog('info', 'Native project file drag started', { count: sources.length });
    } catch (error) {
      writeLog('error', 'Unable to start native project file drag', error);
      if (!event.sender.isDestroyed()) event.sender.send('app-error', error.message || String(error));
    } finally {
      if (!event.sender.isDestroyed()) {
        const ownerWindow = BrowserWindow.fromWebContents(event.sender);
        const contentBounds = ownerWindow?.getContentBounds();
        const cursor = screen.getCursorScreenPoint();
        const clientX = contentBounds ? cursor.x - contentBounds.x : -1;
        const clientY = contentBounds ? cursor.y - contentBounds.y : -1;
        const insideWindow = Boolean(contentBounds && clientX >= 0 && clientY >= 0 && clientX < contentBounds.width && clientY < contentBounds.height);
        event.sender.send('workspace-file-drag-ended', { paths: validatedRelativePaths, clientX, clientY, insideWindow });
      }
    }
  });
  
  ipcMain.handle('workspace-file-clipboard-status', async () => {
    try {
      const systemClipboard = await readSystemFileClipboard();
      if (systemClipboard) {
        const systemSources = systemClipboard.sources?.filter(source => fs.existsSync(path.resolve(source))) || [];
        return { success: true, hasFiles: systemSources.length > 0 };
      }
    } catch (error) {
      writeLog('warn', 'Unable to inspect the system file clipboard', error);
      if (process.platform === 'win32') return { success: false, hasFiles: false, error: error.message || String(error) };
    }
    if (process.platform === 'win32') return { success: true, hasFiles: false };
    return { success: true, hasFiles: Boolean(fileOperationState.projectFileClipboard?.sources?.some(source => fs.existsSync(source))) };
  });
  
  ipcMain.handle('workspace-file-operation', async (event, workspacePath, status, projectName, operation, relativePaths = [], targetRelativePath = '', nextName = '', options = {}) => {
    let suppressedProjectRoot = '';
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      if (new Set(['import', 'move', 'paste', 'trash', 'select', 'rename']).has(operation)) {
        cancelMediaTrackingScan?.(ensureWorkspace(workspacePath), projectName);
        suppressWorkspaceWatchPath?.(root);
        suppressedProjectRoot = root;
      }
      const resolveInsideProject = relativePath => {
        const target = path.resolve(root, relativePath || '.');
        if (target !== root && !target.startsWith(root + path.sep)) throw new Error('无效的文件路径');
        return target;
      };
      if (operation === 'import') {
        if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.length > 500) throw new Error('没有可导入的文件');
        const destinationDir = resolveInsideProject(targetRelativePath);
        if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('目标文件夹不存在');
        const sources = Array.from(new Set(relativePaths.map(source => {
          if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('无效的外部文件路径');
          const resolvedSource = path.resolve(source);
          if (!fs.existsSync(resolvedSource)) throw new Error(`文件不存在：${path.basename(resolvedSource)}`);
          if (resolvedSource === destinationDir || destinationDir.startsWith(resolvedSource + path.sep)) throw new Error('不能将文件夹复制到自身或其子文件夹中');
          return resolvedSource;
        })));
        const reservedDestinations = new Set();
        const importPlan = sources.map(source => {
          const stat = fs.statSync(source);
          let destination = path.join(destinationDir, path.basename(source));
          const parsed = path.parse(destination);
          let index = 1;
          while (fs.existsSync(destination) || reservedDestinations.has(destination.toLowerCase())) {
            destination = stat.isDirectory()
              ? path.join(destinationDir, `${path.basename(source)} (${index++})`)
              : path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
          }
          reservedDestinations.add(destination.toLowerCase());
          return { source, destination };
        });
        const createdTargets = [];
        try {
          for (const entry of importPlan) {
            createdTargets.push(entry.destination);
            await fs.promises.cp(entry.source, entry.destination, { recursive: true, errorOnExist: true, preserveTimestamps: true });
          }
        } catch (error) {
          await removeCreatedPasteTargets(createdTargets);
          throw error;
        }
        writeLog('info', 'External files imported by drag and drop', { projectName, targetRelativePath, count: importPlan.length });
        if (importPlan.length) await pushUndoOperation({ kind: 'remove-created', paths: importPlan.map(item => item.destination), label: '导入' });
        return { success: true, count: importPlan.length };
      }
      const sources = relativePaths.map(resolveInsideProject);
      if (operation === 'move') {
        if (!sources.length) throw new Error('没有可移动的文件');
        const destinationDir = resolveInsideProject(targetRelativePath);
        if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('目标文件夹不存在');
        const reservedDestinations = new Set();
        const movePlan = sources.map(source => {
          if (!fs.existsSync(source)) throw new Error(`文件不存在：${path.basename(source)}`);
          const stat = fs.statSync(source);
          if (source === destinationDir || destinationDir.startsWith(source + path.sep)) throw new Error('不能将文件夹移动到自身或其子文件夹中');
          let destination = path.join(destinationDir, path.basename(source));
          const parsed = path.parse(destination);
          let index = 1;
          while (fs.existsSync(destination) || reservedDestinations.has(destination.toLowerCase())) {
            destination = stat.isDirectory()
              ? path.join(destinationDir, `${path.basename(source)} (${index++})`)
              : path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
          }
          reservedDestinations.add(destination.toLowerCase());
          return { source, destination };
        });
        for (const entry of movePlan) await fs.promises.rename(entry.source, entry.destination);
        writeLog('info', 'Project files moved by internal drag', { projectName, targetRelativePath, count: movePlan.length });
        if (movePlan.length) await pushUndoOperation({ kind: 'move', moves: movePlan });
        return {
          success: true,
          count: movePlan.length,
          moves: movePlan.map(entry => ({
            sourceRelativePath: path.relative(root, entry.source),
            destinationRelativePath: path.relative(root, entry.destination),
          })),
        };
      }
      if (operation === 'copy' || operation === 'cut') {
        if (!sources.length) throw new Error('未选择文件');
        fileOperationState.projectFileClipboard = process.platform === 'win32' ? null : { operation, sources };
        try {
          await writeSystemFileClipboard(sources, operation);
        } catch (error) {
          fileOperationState.projectFileClipboard = null;
          writeLog('warn', 'Unable to sync project files to the system clipboard', error);
          throw new Error(`无法写入 Windows 文件剪贴板：${error.message || String(error)}`);
        }
        return { success: true, count: sources.length };
      }
      if (operation === 'paste') {
        if (activeProjectFileOperations.size) throw new Error('已有文件粘贴任务正在进行');
        const operationId = crypto.randomUUID();
        const job = { cancelled: false, finishing: false };
        const createdTargets = [];
        const stagedReplacements = [];
        const committedTargets = [];
        let topLevelTargets = [];
        let incomingRoot = '';
        let replacementRoot = '';
        activeProjectFileOperations.set(operationId, job);
        const publish = payload => {
          if (!event.sender.isDestroyed()) event.sender.send('workspace-file-operation-progress', { operationId, operation: 'paste', ...payload });
        };
        publish({ phase: 'scanning', progress: 0, currentName: '', bytesCopied: 0, totalBytes: 0 });
        try {
          const requestedDestination = resolveInsideProject(targetRelativePath);
          if (!fs.existsSync(requestedDestination) || !fs.statSync(requestedDestination).isDirectory()) throw new Error('目标文件夹不存在');
          const destinationDir = assertExistingInside(root, requestedDestination, '粘贴目标文件夹', true);
          let clipboardSnapshot = null;
          try {
            const systemClipboard = await readSystemFileClipboard();
            if (systemClipboard) {
              const systemSources = (systemClipboard.sources || []).map(source => path.resolve(source)).filter(source => fs.existsSync(source));
              if (systemSources.length) clipboardSnapshot = { operation: systemClipboard.operation, sources: systemSources };
            }
          } catch (error) {
            if (process.platform === 'win32') throw new Error(`无法读取 Windows 文件剪贴板：${error.message || String(error)}`);
            writeLog('warn', 'Unable to read system file clipboard; using internal fallback', error);
          }
          if (!clipboardSnapshot && process.platform !== 'win32' && fileOperationState.projectFileClipboard?.sources?.length) {
            clipboardSnapshot = { operation: fileOperationState.projectFileClipboard.operation, sources: [...fileOperationState.projectFileClipboard.sources] };
          }
          if (!clipboardSnapshot?.sources?.length) throw new Error('剪贴板中没有文件或文件夹');

          const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
          const uniqueSources = [];
          const seenSources = new Set();
          for (const candidate of clipboardSnapshot.sources) {
            const source = path.resolve(candidate);
            const key = pathKey(source);
            if (seenSources.has(key) || !fs.existsSync(source)) continue;
            seenSources.add(key);
            uniqueSources.push(source);
          }
          const requestedItems = [];
          for (const source of uniqueSources) {
            if (clipboardSnapshot.operation === 'cut' && pathKey(path.dirname(source)) === pathKey(destinationDir)) continue;
            const sourceStat = await fs.promises.lstat(source);
            if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error(`不支持粘贴此文件类型：${path.basename(source)}`);
            if (sourceStat.isDirectory() && pathKey(destinationDir).startsWith(`${pathKey(source)}${path.sep}`)) throw new Error('不能将文件夹粘贴到自身内部');
            const desiredDestination = path.join(destinationDir, path.basename(source));
            const sameSource = pathKey(desiredDestination) === pathKey(source);
            const conflict = !sameSource && fs.existsSync(desiredDestination);
            requestedItems.push({ source, sourceStat, desiredDestination, sameSource, conflict, conflictIdentity: conflict ? await capturePathIdentity(desiredDestination) : null });
          }

          const pasteConflicts = requestedItems.filter(item => item.conflict).map(item => ({ source: item.source, destination: item.desiredDestination, isDirectory: fs.statSync(item.desiredDestination).isDirectory() }));
          let replaceConflicts = false;
          if (pasteConflicts.length) {
            const names = pasteConflicts.slice(0, 6).map(item => `“${path.basename(item.destination)}”`).join('、');
            const fileCount = pasteConflicts.filter(item => !item.isDirectory).length;
            const folderCount = pasteConflicts.length - fileCount;
            const conflictSummary = [fileCount ? `${fileCount} 个文件` : '', folderCount ? `${folderCount} 个文件夹` : ''].filter(Boolean).join('和');
            const more = pasteConflicts.length > 6 ? ` 等 ${conflictSummary}` : '';
            const conflictPolicy = ['replace', 'keep-both'].includes(options?.pasteConflictPolicy) ? options.pasteConflictPolicy : '';
            if (!conflictPolicy) {
              publish({ phase: 'complete', progress: 100, currentName: '', count: 0, decisionRequired: true });
              return {
                success: true,
                count: 0,
                operationId,
                requiresDecision: {
                  kind: 'paste-conflict',
                  names: pasteConflicts.slice(0, 6).map(item => path.basename(item.destination)),
                  fileCount,
                  folderCount,
                  message: `目标位置已有 ${names}${more}`,
                  detail: `发现 ${conflictSummary}。选择替换后，仅在新内容准备完成时替换旧项目；选择保留两者时，新项目会自动重命名。`,
                },
              };
            }
            replaceConflicts = conflictPolicy === 'replace';
          }

          topLevelTargets = [];
          const reservedTargets = new Set();
          const replacedDestinations = new Set();
          const replacementIdentities = new Map();
          for (const item of requestedItems) {
            throwIfCancelled(() => job.cancelled);
            const desiredKey = pathKey(item.desiredDestination);
            let destination;
            if (replaceConflicts && item.conflict && !reservedTargets.has(desiredKey)) {
              destination = item.desiredDestination;
              reservedTargets.add(desiredKey);
              replacedDestinations.add(desiredKey);
              replacementIdentities.set(desiredKey, item.conflictIdentity);
            } else {
              destination = uniqueDestination(destinationDir, path.basename(item.source), reservedTargets, item.sourceStat.isDirectory());
            }
            topLevelTargets.push({ source: item.source, destination });
          }

          const destinationVolume = path.parse(destinationDir).root.toLocaleLowerCase();
          const sameVolumeCut = clipboardSnapshot.operation === 'cut'
            && process.platform === 'win32'
            && topLevelTargets.every(item => path.parse(item.source).root.toLocaleLowerCase() === destinationVolume);
          const plan = [];
          if (!sameVolumeCut) {
            incomingRoot = path.join(destinationDir, `.photoflow-paste-${operationId}`);
            for (const [index, target] of topLevelTargets.entries()) {
              target.stagedDestination = path.join(incomingRoot, `${index}-${path.basename(target.destination)}`);
              await collectCopyPlan(target.source, target.stagedDestination, plan, { isCancelled: () => job.cancelled });
            }
            await assertDiskSpace(destinationDir, plan.reduce((sum, entry) => sum + entry.size, 0));
          }

          const stageReplacements = async () => {
            if (!replacedDestinations.size || replacementRoot) return;
            replacementRoot = path.join(destinationDir, `.photoflow-replace-${operationId}`);
            await fs.promises.mkdir(replacementRoot, { recursive: false });
            for (const [index, destination] of [...replacedDestinations].map(key => topLevelTargets.find(item => pathKey(item.destination) === key)?.destination).filter(Boolean).entries()) {
              if (!await samePathIdentity(destination, replacementIdentities.get(pathKey(destination)))) throw new Error(`同名项目“${path.basename(destination)}”在确认后发生变化，请重新粘贴`);
              const backup = path.join(replacementRoot, `${index}-${path.basename(destination)}`);
              const originalIdentity = await capturePathIdentity(destination);
              await fs.promises.rename(destination, backup);
              stagedReplacements.push({ original: destination, backup, originalIdentity });
            }
          };

          const rollbackStagedReplacements = async () => {
            for (const item of [...stagedReplacements].reverse()) {
              if (!fs.existsSync(item.backup)) continue;
              if (fs.existsSync(item.original)) await fs.promises.rm(item.original, { recursive: true, force: true });
              await fs.promises.rename(item.backup, item.original);
            }
            if (replacementRoot && !stagedReplacements.some(item => fs.existsSync(item.backup))) await fs.promises.rm(replacementRoot, { recursive: true, force: true }).catch(() => undefined);
          };

          const finalizeReplacements = async () => {
            const items = [];
            let permanentCount = 0;
            let retainedCount = 0;
            for (const item of stagedReplacements) {
              try {
                const recycled = await recycleBinService.trash(item.backup);
                if (recycled.permanent) permanentCount += 1;
                items.push({ original: item.original, originalIdentity: item.originalIdentity, recyclePidl: recycled.recyclePidl || '', preciseRestore: recycled.preciseRestore !== false, permanent: Boolean(recycled.permanent) });
              } catch (error) {
                retainedCount += 1;
                writeLog('warn', 'Unable to recycle staged replacement; retaining internal undo backup', { path: item.original, error: error.message || String(error) });
                items.push({ original: item.original, originalIdentity: item.originalIdentity, backup: item.backup, backupRoot: replacementRoot, permanent: false });
              }
            }
            if (replacementRoot && !items.some(item => item.backup)) await fs.promises.rm(replacementRoot, { recursive: true, force: true }).catch(() => undefined);
            return { items, permanentCount, retainedCount };
          };

          if (sameVolumeCut) {
            await stageReplacements();
            const moved = [];
            publish({ phase: 'moving', progress: 0, currentName: '', bytesCopied: 0, totalBytes: 0, filesCopied: 0, totalFiles: topLevelTargets.length });
            try {
              for (const [index, item] of topLevelTargets.entries()) {
                throwIfCancelled(() => job.cancelled);
                publish({ phase: 'moving', progress: Math.round(index / Math.max(1, topLevelTargets.length) * 100), currentName: path.basename(item.source), bytesCopied: 0, totalBytes: 0, filesCopied: index, totalFiles: topLevelTargets.length });
                await movePathAtomic(item.source, item.destination, { isCancelled: () => job.cancelled });
                moved.push(item);
              }
            } catch (error) {
              for (const item of [...moved].reverse()) {
                if (fs.existsSync(item.destination) && !fs.existsSync(item.source)) await movePathAtomic(item.destination, item.source).catch(() => undefined);
              }
              await rollbackStagedReplacements();
              throw error;
            }
            job.finishing = true;
            fileOperationState.projectFileClipboard = null;
            try { clipboard.clear(); } catch (error) { writeLog('warn', 'Unable to clear completed cut clipboard', error); }
            const count = topLevelTargets.length;
            const replacements = await finalizeReplacements();
            if (count) await pushUndoOperation(replacements.items.length ? { kind: 'paste-replace', mode: 'cut', moves: topLevelTargets, items: replacements.items, backupRoot: replacementRoot } : { kind: 'move', moves: topLevelTargets }).catch(error => {
              writeLog('warn', 'Unable to record paste undo history', error);
            });
            publish({ phase: 'complete', progress: 100, currentName: '', bytesCopied: 0, totalBytes: 0, filesCopied: count, totalFiles: count, count });
            writeLog('info', 'Project files moved by same-volume rename', { projectName, targetRelativePath, count, operationId });
            return { success: true, count, operationId, replacedCount: replacements.items.length, replacedNames: replacements.items.map(item => path.basename(item.original)), replacedPermanentCount: replacements.permanentCount, replacedRetainedCount: replacements.retainedCount };
          }

          const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
          const totalFiles = plan.filter(entry => entry.kind === 'file').length;
          let bytesCopied = 0;
          let filesCopied = 0;
          let lastPublishedAt = 0;
          const reportCopyProgress = (currentName, force = false) => {
            const now = Date.now();
            if (!force && now - lastPublishedAt < 150) return;
            lastPublishedAt = now;
            const progress = totalBytes > 0
              ? Math.min(99, Math.round(bytesCopied / totalBytes * 100))
              : Math.min(99, Math.round(filesCopied / Math.max(1, totalFiles) * 100));
            publish({ phase: 'copying', progress, currentName, bytesCopied, totalBytes, filesCopied, totalFiles });
          };
          await fs.promises.mkdir(incomingRoot, { recursive: false });
          createdTargets.push(incomingRoot);
          const topLevelTargetPaths = new Set(topLevelTargets.map(item => item.stagedDestination));
          const markCreatedTarget = destination => {
            if (topLevelTargetPaths.has(destination) && !createdTargets.includes(destination)) createdTargets.push(destination);
          };
          reportCopyProgress('', true);
          const transferStats = await copyPlannedFiles(plan, {
            destinationRoot: destinationDir,
            diskSpaceChecked: true,
            durable: clipboardSnapshot.operation === 'cut',
            isCancelled: () => job.cancelled,
            onCreated: markCreatedTarget,
            onFileStart: entry => reportCopyProgress(path.basename(entry.source)),
            onProgress: ({ entry, bytesDelta, fileCompleted }) => {
              bytesCopied += bytesDelta;
              if (fileCompleted) filesCopied += 1;
              reportCopyProgress(path.basename(entry.source));
            },
          });
          throwIfCancelled(() => job.cancelled);
          await stageReplacements();
          try {
            for (const item of topLevelTargets) {
              throwIfCancelled(() => job.cancelled);
              await fs.promises.rename(item.stagedDestination, item.destination);
              committedTargets.push(item);
            }
            await fs.promises.rm(incomingRoot, { recursive: true, force: true });
            createdTargets.length = 0;
          } catch (error) {
            for (const item of [...committedTargets].reverse()) {
              if (fs.existsSync(item.destination) && !fs.existsSync(item.stagedDestination)) await fs.promises.rename(item.destination, item.stagedDestination).catch(() => undefined);
            }
            await rollbackStagedReplacements().catch(() => undefined);
            throw error;
          }
          if (clipboardSnapshot.operation === 'cut') {
            job.finishing = true;
            publish({ phase: 'finishing', progress: 99, currentName: '正在移除源文件', bytesCopied, totalBytes, filesCopied, totalFiles });
            await removeCopiedSources(plan);
            fileOperationState.projectFileClipboard = null;
            if (process.platform === 'win32') clipboard.clear();
          }
          const count = topLevelTargets.length;
          const replacements = await finalizeReplacements();
          if (count) await pushUndoOperation(replacements.items.length
            ? { kind: 'paste-replace', mode: clipboardSnapshot.operation, moves: topLevelTargets, items: replacements.items, backupRoot: replacementRoot }
            : clipboardSnapshot.operation === 'cut'
              ? { kind: 'move', moves: topLevelTargets }
              : { kind: 'remove-created', paths: topLevelTargets.map(item => item.destination), label: '粘贴' }).catch(error => {
                writeLog('warn', 'Unable to record paste undo history', error);
              });
          publish({ phase: 'complete', progress: 100, currentName: '', bytesCopied, totalBytes, filesCopied, totalFiles, count });
          writeLog('info', 'Project files pasted', { projectName, targetRelativePath, count, operationId, ...transferStats });
          return { success: true, count, operationId, replacedCount: replacements.items.length, replacedNames: replacements.items.map(item => path.basename(item.original)), replacedPermanentCount: replacements.permanentCount, replacedRetainedCount: replacements.retainedCount };
        } catch (error) {
          // Once cut finalization starts, keeping the completed copies is the only
          // data-safe fallback if removing a source fails partway through.
          if (!job.finishing) {
            await removeCreatedPasteTargets(createdTargets);
            for (const item of [...stagedReplacements].reverse()) {
              if (!fs.existsSync(item.backup)) continue;
              if (fs.existsSync(item.original)) await fs.promises.rm(item.original, { recursive: true, force: true }).catch(() => undefined);
              await fs.promises.rename(item.backup, item.original).catch(() => undefined);
            }
            if (replacementRoot && !stagedReplacements.some(item => fs.existsSync(item.backup))) await fs.promises.rm(replacementRoot, { recursive: true, force: true }).catch(() => undefined);
          } else {
            const recoveryNames = [];
            const reservedRecovery = new Set(topLevelTargets.map(item => process.platform === 'win32' ? path.resolve(item.destination).toLowerCase() : path.resolve(item.destination)));
            for (const item of [...stagedReplacements].reverse()) {
              if (!fs.existsSync(item.backup)) continue;
              if (fs.existsSync(item.original)) {
                const stat = await fs.promises.lstat(item.original).catch(() => null);
                const recovery = uniqueDestination(path.dirname(item.original), path.basename(item.original), reservedRecovery, Boolean(stat?.isDirectory()));
                await fs.promises.rename(item.original, recovery).catch(() => undefined);
                if (fs.existsSync(recovery)) recoveryNames.push(path.basename(recovery));
              }
              if (!fs.existsSync(item.original)) await fs.promises.rename(item.backup, item.original).catch(() => undefined);
            }
            const retainedReplacementBackup = stagedReplacements.some(item => fs.existsSync(item.backup));
            if (replacementRoot && !retainedReplacementBackup) await fs.promises.rm(replacementRoot, { recursive: true, force: true }).catch(() => undefined);
            if (recoveryNames.length) error.message = `${error.message || String(error)}；原同名项目已恢复，已复制的新内容保留为 ${recoveryNames.join('、')}`;
            else if (retainedReplacementBackup) error.message = `${error.message || String(error)}；旧内容的恢复副本已安全保留，请不要继续修改目标文件并重试撤销`;
          }
          if (error?.code === CANCELLED_CODE) {
            publish({ phase: 'cancelled', progress: 0, currentName: '' });
            writeLog('info', 'Project file paste cancelled', { projectName, operationId });
            return { success: false, cancelled: true, operationId, error: '粘贴已取消' };
          }
          publish({ phase: 'failed', progress: 0, currentName: '', error: error.message || String(error) });
          throw error;
        } finally {
          activeProjectFileOperations.delete(operationId);
        }
      }
      if (operation === 'trash') {
        const existingSources = sources.filter(source => fs.existsSync(source));
        const operationId = crypto.randomUUID();
        const totalCount = existingSources.length;
        const publish = payload => {
          if (!event.sender.isDestroyed()) event.sender.send('workspace-file-operation-progress', { operationId, operation: 'trash', ...payload });
        };
        let processedCount = 0;
        let permanentCount = 0;
        const undoItems = [];
        const workspaceRoot = ensureWorkspace(workspacePath);
        let persistedTrashRecord = null;
        const persistTrashUndo = async () => {
          if (!undoItems.length || persistedTrashRecord) return;
          persistedTrashRecord = await workspaceRepository.addUndoRecord(workspaceRoot, { kind: 'trash', payload: { items: undoItems } });
          await pushUndoOperation({ kind: 'trash', workspaceRoot, persistentId: persistedTrashRecord.id, items: [...undoItems] });
        };
        publish({ phase: 'trashing', progress: 0, currentName: '', processedCount, totalCount });
        try {
          for (const source of existingSources) {
            publish({ phase: 'trashing', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: path.basename(source), processedCount, totalCount });
            const originalIdentity = await capturePathIdentity(source);
            const recycled = await recycleBinService.trash(source);
            if (recycled.recyclePidl) undoItems.push({ original: source, originalIdentity, recyclePidl: recycled.recyclePidl, preciseRestore: recycled.preciseRestore !== false });
            if (recycled.permanent) permanentCount += 1;
            processedCount += 1;
            publish({ phase: 'trashing', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: path.basename(source), processedCount, totalCount });
          }
          publish({ phase: 'complete', progress: 100, currentName: '', processedCount, totalCount });
          writeLog('info', 'Project files moved to trash', { projectName, count: processedCount, operationId });
          await persistTrashUndo();
          return { success: true, count: processedCount, permanentCount, operationId };
        } catch (error) {
          await persistTrashUndo().catch(persistError => writeLog('error', 'Unable to persist partial trash undo record', persistError));
          publish({ phase: 'failed', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: '', processedCount, totalCount, error: error.message || String(error) });
          throw error;
        }
      }
      if (operation === 'select') {
        if (!sources.length) throw new Error('未选择媒体文件');
        const imageDirName = '图片选片';
        const videoDirName = '视频选片';
        const imageTarget = path.join(root, imageDirName);
        const videoTarget = path.join(root, videoDirName);
        let count = 0;
        let imageCount = 0;
        let videoCount = 0;
        const createdTargets = [];
        for (const source of sources) {
          if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('只能选择媒体文件');
          const extension = path.extname(source).toLowerCase();
          const isVideo = VIDEO_EXTENSIONS.has(extension);
          const isImage = IMAGE_EXTENSIONS.has(extension) || RAW_EXTENSIONS.has(extension);
          if (!isVideo && !isImage) throw new Error('只能选择媒体文件');
          const destinationDir = isVideo ? videoTarget : imageTarget;
          fs.mkdirSync(destinationDir, { recursive: true });
          let destination = path.join(destinationDir, path.basename(source));
          const parsed = path.parse(destination);
          let index = 1;
          while (fs.existsSync(destination)) destination = path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
          await copyFileAtomic(source, destination);
          createdTargets.push(destination);
          count += 1;
          if (isVideo) videoCount += 1;
          else imageCount += 1;
        }
        if (createdTargets.length) await pushUndoOperation({ kind: 'remove-created', paths: createdTargets, label: '选片复制' });
        return { success: true, count, imageCount, videoCount };
      }
      if (operation === 'rename') {
        if (!sources.length || !nextName.trim()) throw new Error('请选择文件并输入新名称');
        if (sources.some(source => isProtectedProjectFolderPath({ fs, path, projectRoot: root, candidate: source }))) {
          throw new Error('该文件夹由项目工作流管理，不能使用普通重命名；进度文件夹请使用“修改进度”');
        }
        const baseName = nextName.trim();
        const explicitNames = Array.isArray(options.renameNames) && options.renameNames.length === sources.length ? options.renameNames.map(name => String(name).trim()) : null;
        const destinations = sources.map((source, index) => {
          const extension = path.extname(source);
          const fileName = explicitNames ? explicitNames[index] : sources.length === 1 ? baseName : `${baseName}_${String(index + 1).padStart(2, '0')}${extension}`;
          if (!fileName || path.basename(fileName) !== fileName || /[<>:"/\\|?*\x00-\x1f]/.test(fileName) || /[. ]$/.test(fileName)) throw new Error(`无效的文件名：${fileName || '空文件名'}`);
          return path.join(path.dirname(source), fileName);
        });
        if (sources.some((source, index) => path.dirname(source).toLocaleLowerCase() === root.toLocaleLowerCase()
          && fs.statSync(source).isDirectory() && isProtectedProjectFolderName(path.basename(destinations[index])))) {
          throw new Error('该名称保留给项目工作流使用，请输入其他文件夹名称');
        }
        const normalizedDestinations = destinations.map(destination => path.resolve(destination).toLocaleLowerCase());
        if (new Set(normalizedDestinations).size !== normalizedDestinations.length) throw new Error('生成的新文件名存在重复');
        const normalizedSources = new Set(sources.map(source => path.resolve(source).toLocaleLowerCase()));
        for (const destination of destinations) {
          if (path.resolve(destination) === root || !path.resolve(destination).startsWith(root + path.sep)) throw new Error('无效的文件名');
          if (fs.existsSync(destination) && !normalizedSources.has(path.resolve(destination).toLocaleLowerCase())) throw new Error(`目标名称已被占用：${path.basename(destination)}`);
        }
        const moves = sources.map((source, index) => ({ source, destination: destinations[index] })).filter(move => path.resolve(move.source) !== path.resolve(move.destination));
        const staged = [];
        try {
          for (const move of moves) {
            const temporary = path.join(path.dirname(move.source), `.photoflow-rename-${crypto.randomUUID()}${path.extname(move.source)}`);
            await fs.promises.rename(move.source, temporary);
            staged.push({ ...move, temporary, completed: false });
          }
          for (const move of staged) {
            await fs.promises.rename(move.temporary, move.destination);
            move.completed = true;
          }
        } catch (error) {
          for (const move of [...staged].reverse()) {
            try {
              if (move.completed && fs.existsSync(move.destination) && !fs.existsSync(move.source)) await fs.promises.rename(move.destination, move.source);
              else if (!move.completed && fs.existsSync(move.temporary) && !fs.existsSync(move.source)) await fs.promises.rename(move.temporary, move.source);
            } catch { /* best-effort rollback; original error is reported below */ }
          }
          throw error;
        }
        writeLog('info', 'Project files renamed', { projectName, count: sources.length });
        if (moves.length) await pushUndoOperation({ kind: 'files', moves });
        return { success: true, count: sources.length };
      }
      throw new Error('不支持的文件操作');
    } catch (error) {
      const errorCode = error && typeof error === 'object' ? error.code : '';
      const transferStage = error && typeof error === 'object' ? error.transferStage : '';
      const affectedPath = error && typeof error === 'object' ? (error.sourcePath || error.destinationPath) : '';
      const affectedName = affectedPath ? path.basename(affectedPath) : '';
      const accessFailure = transferStage === 'inspect-source'
        ? `无法读取源文件${affectedName ? `“${affectedName}”` : ''}，文件可能正被其他程序占用或当前账户没有读取权限`
        : transferStage === 'prepare-target'
          ? `无法在目标文件夹创建${affectedName ? `“${affectedName}”` : '文件'}，请检查目标文件夹权限`
        : transferStage === 'sync-temporary'
          ? `无法完成文件${affectedName ? `“${affectedName}”` : ''}的安全写入校验，源文件已保留`
        : transferStage === 'copy-data'
          ? `复制文件${affectedName ? `“${affectedName}”` : ''}时被系统拒绝，请关闭正在读取该文件的程序后重试`
          : transferStage === 'commit-target'
            ? `写入目标文件${affectedName ? `“${affectedName}”` : ''}时被系统拒绝，请检查目标文件夹权限`
            : '文件正在被其他程序占用或没有访问权限，请关闭相关程序后重试';
      const errorMessage = errorCode === 'EPERM' || errorCode === 'EBUSY' || errorCode === 'EACCES'
        ? accessFailure
        : errorCode === 'ENOSPC'
          ? '目标磁盘空间不足，操作已停止；已创建的不完整副本会自动清理'
          : errorCode === 'ENAMETOOLONG'
            ? '文件路径过长，请缩短项目路径或文件名后重试'
            : errorCode === 'EROFS'
              ? '目标磁盘为只读状态，无法写入文件'
              : errorCode === 'ENOENT' || errorCode === 'ENOTDIR'
                ? '操作中的文件或文件夹已在外部移动或删除，请刷新后重试'
                : error.message || String(error);
      writeLog('error', 'Project file operation failed', { projectName, operation, targetRelativePath, count: relativePaths.length, errorCode: errorCode || undefined, transferStage: transferStage || undefined, sourcePath: error?.sourcePath, destinationPath: error?.destinationPath, nativeError: error?.message || String(error), error: errorMessage });
      return { success: false, error: errorMessage, errorCode: errorCode || undefined, transferStage: transferStage || undefined };
    } finally {
      if (suppressedProjectRoot) releaseWorkspaceWatchPath?.(suppressedProjectRoot);
    }
  });
};

module.exports = { registerFileOperationsIpc };
