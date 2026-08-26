const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'file-operation-state-model.ts')).href);
  const identity = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'file-operation-identity-model.ts')).href);
  const entry = (relativePath, kind = 'file') => ({ name: relativePath.split('/').pop(), path: `D:/project/${relativePath}`, relativePath, kind, extension: '', size: 1, createdAt: 1, updatedAt: 1 });
  const renameSource = { ...entry('a.txt'), previewUrl: 'safe-preview://a' };
  const rename = { id: 'rename', kind: 'rename', label: '正在重命名', lockedPaths: ['a.txt', 'b.txt'], affectedDirectories: [''], tombstonePaths: ['a.txt'], optimisticEntries: [{ ...renameSource, name: 'b.txt', path: 'D:/project/b.txt', relativePath: 'b.txt', pendingSourceRelativePath: 'a.txt' }] };
  assert.equal(model.pendingPathConflicts([rename], ['a.txt']), true, 'the source path is locked');
  assert.equal(model.pendingPathConflicts([rename], ['folder/a.txt']), false, 'unrelated paths remain available');
  assert.equal(model.addPendingFileOperation([rename], { ...rename, id: 'conflict' }).length, 1, 'conflicting operations are rejected');
  const renamed = model.applyPendingFileOperations([renameSource, entry('keep.txt')], '', [rename]);
  assert.deepEqual(renamed.map(item => item.relativePath).sort(), ['b.txt', 'keep.txt']);
  const renamedEntry = renamed.find(item => item.relativePath === 'b.txt');
  assert.equal(renamedEntry.name, 'b.txt', 'the final optimistic name is visible immediately');
  assert.equal(renamedEntry.pendingOperationId, 'rename', 'rename retains its invisible path lock identity');
  assert.equal(renamedEntry.pendingOperationLabel, undefined, 'rename exposes no processing label');
  assert.equal(renamedEntry.pendingOperationKind, undefined, 'rename exposes no processing kind to visual rendering');
  assert.equal(renamedEntry.pendingPlaceholder, undefined, 'rename is never rendered as a placeholder');
  assert.equal(renamedEntry.path, 'D:/project/b.txt', 'rename predicts the final physical path instead of asking the icon loader for the tombstoned source');
  assert.equal(renamedEntry.previewUrl, renameSource.previewUrl, 'rename retains reusable preview metadata while predicting the final physical path');
  assert.equal(renamedEntry.pendingSourceRelativePath, 'a.txt', 'rename retains an internal stable-identity alias for the source entry');
  const malformedRename = { ...rename, id: 'malformed', optimisticEntries: [{ ...entry('c.txt'), pendingSourceRelativePath: 'not-the-tombstone.txt' }] };
  assert.deepEqual(model.applyPendingFileOperations([renameSource], '', [malformedRename]), [], 'an optimistic rename is admitted only by an explicit source-to-tombstone mapping');
  const batchSources = [entry('first.txt'), entry('second.txt')];
  const batchRename = {
    id: 'batch-rename', kind: 'rename', label: '正在批量重命名',
    lockedPaths: ['first.txt', 'second.txt', 'renamed-1.txt', 'renamed-2.txt'], affectedDirectories: [''], tombstonePaths: ['first.txt', 'second.txt'],
    optimisticEntries: [
      { ...batchSources[0], name: 'renamed-1.txt', path: 'D:/project/renamed-1.txt', relativePath: 'renamed-1.txt', pendingSourceRelativePath: batchSources[0].relativePath },
      { ...batchSources[1], name: 'renamed-2.txt', path: 'D:/project/renamed-2.txt', relativePath: 'renamed-2.txt', pendingSourceRelativePath: batchSources[1].relativePath },
    ],
  };
  const batchRenamed = model.applyPendingFileOperations(batchSources, '', [batchRename]);
  assert.deepEqual(batchRenamed.map(item => [item.relativePath, item.pendingSourceRelativePath]), [['renamed-1.txt', 'first.txt'], ['renamed-2.txt', 'second.txt']], 'batch rename preserves the explicit source alias at each index and emits one entry per source');

  const deletion = { id: 'delete', kind: 'delete', label: '正在移入回收站', lockedPaths: ['a.txt', 'b.txt'], affectedDirectories: [''], tombstonePaths: ['a.txt', 'b.txt'] };
  assert.deepEqual(model.applyPendingFileOperations([entry('a.txt'), entry('b.txt'), entry('c.txt')], '', [deletion]).map(item => item.relativePath), ['c.txt']);
  const folderDeletion = { ...deletion, id: 'folder-delete', lockedPaths: ['folder'], tombstonePaths: ['folder'] };
  assert.deepEqual(model.applyPendingFileOperations([entry('folder', 'folder'), entry('folder/child.txt'), entry('keep.txt')], undefined, [folderDeletion]).map(item => item.relativePath), ['keep.txt'], 'recursive views hide a tombstoned subtree');
  // Partial success is deliberately settled from an authoritative listing: if
  // only b.txt remains there, removing the overlay restores exactly b.txt, not
  // all requested paths and not an arbitrary item inferred from count.
  assert.deepEqual(model.applyPendingFileOperations([entry('b.txt'), entry('c.txt')], '', model.removePendingFileOperation([deletion], 'delete')).map(item => item.relativePath), ['b.txt', 'c.txt']);
  assert.deepEqual(model.applyPendingFileOperations([entry('c.txt')], '', model.removePendingFileOperation([deletion], 'delete')).map(item => item.relativePath), ['c.txt'], 'terminal calibration keeps successfully deleted items absent');

  const moving = { id: 'move', kind: 'move', label: '正在移动', lockedPaths: ['src/a.txt', 'dest'], affectedDirectories: ['src', 'dest'], tombstonePaths: ['src/a.txt'], optimisticEntries: [entry('dest/a.txt')] };
  assert.deepEqual(model.applyPendingFileOperations([entry('src/a.txt')], 'src', [moving]), [], 'source is tombstoned during move');
  assert.deepEqual(model.applyPendingFileOperations([], 'dest', [moving]), [], 'move adds no destination placeholder to the file area');
  for (const kind of ['create', 'paste', 'import', 'copy', 'cut']) {
    const operation = { id: kind, kind, label: `pending ${kind}`, lockedPaths: ['dest/new'], affectedDirectories: ['dest'], optimisticEntries: [entry('dest/new')] };
    assert.deepEqual(model.applyPendingFileOperations([], 'dest', [operation]), [], `${kind} cannot inject a file-area entry`);
  }
  assert.deepEqual(model.operationRefreshDirectories(moving, { affectedDirectories: ['dest', 'actual'] }), ['src', 'dest', 'actual'], 'backend directories extend the reconciliation scope');
  assert.deepEqual(model.applyPendingFileOperations([entry('src/a.txt')], 'src', model.removePendingFileOperation([moving], 'move')).map(item => item.relativePath), ['src/a.txt'], 'a failed move whose rollback succeeded converges to authority');
  assert.deepEqual(model.applyPendingFileOperations([entry('dest/a.txt')], 'dest', model.removePendingFileOperation([moving], 'move')).map(item => item.relativePath), ['dest/a.txt'], 'a rollback failure converges to the destination reported by authoritative refresh');
  const copying = { id: 'copy', kind: 'copy', label: '正在复制', lockedPaths: ['copy.txt'], affectedDirectories: [] };
  const copyingEntry = model.applyPendingFileOperations([entry('copy.txt')], '', [copying])[0];
  assert.equal(copyingEntry.pendingOperationId, 'copy');
  assert.equal(copyingEntry.pendingOperationLabel, undefined, 'copy lock has no file-area processing label');
  assert.equal(copyingEntry.pendingOperationKind, undefined, 'copy lock has no file-area processing kind');
  assert.equal(model.predictUniqueDirectoryName('新建文件夹', ['新建文件夹', '新建文件夹 (2)']), '新建文件夹 (3)');
  const created = { id: 'create', kind: 'create', label: '正在创建', lockedPaths: ['new-folder'], affectedDirectories: [''], optimisticEntries: [entry('新建文件夹 (3)', 'folder')] };
  assert.deepEqual(model.applyPendingFileOperations([], '', [created]), [], 'mkdir visibility is owned by the normal directory cache, not the pending overlay');

  assert.equal(identity.mayCommitAsyncOperationResult('D:\\Projects\\A', 'd:/projects/a'), true, 'equivalent Windows project identities match');
  assert.equal(identity.mayCommitAsyncOperationResult('D:/Projects/A', 'D:/Projects/B'), false, 'an old project result cannot commit into a new project');
  assert.equal(identity.mayCommitAsyncOperationResult('D:/Inspiration', 'D:/Inspiration', 2, 3), false, 'generation rejects an old request after switching away and back to the same root');
  const newProjectUi = { selected: ['new.txt'], progressFolders: ['new-progress'], notices: [] };
  if (identity.mayCommitAsyncOperationResult('D:/Projects/A', 'D:/Projects/B')) newProjectUi.selected = [];
  assert.deepEqual(newProjectUi, { selected: ['new.txt'], progressFolders: ['new-progress'], notices: [] }, 'old paste/import/move completion cannot mutate new-project UI state');
  const newRootUi = { folders: ['new-root-folder'], navigation: 'new-root/current', collapsed: ['new-root-folder'] };
  if (identity.mayCommitAsyncOperationResult('D:/Root/A', 'D:/Root/B', 1, 2)) newRootUi.navigation = 'old-root/parent';
  assert.deepEqual(newRootUi, { folders: ['new-root-folder'], navigation: 'new-root/current', collapsed: ['new-root-folder'] }, 'old inspiration completion cannot mutate new-root state');

  const workspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const runOperationStart = workspaceSource.indexOf('const runFileOperation');
  const runOperationSource = workspaceSource.slice(runOperationStart, workspaceSource.indexOf('const handleFileShortcut', runOperationStart));
  const directoryDropSource = workspaceSource.slice(workspaceSource.indexOf('const performDirectoryDrop'), workspaceSource.indexOf('const handleEntryDragOver'));
  assert(runOperationSource.includes('const requestedProjectPath = projectPathRef.current'), 'file operations capture the project identity before awaiting');
  assert((runOperationSource.match(/discardStaleProjectOperation\(requestedProjectPath/g) || []).length >= 8, 'paste/copy/cut/delete branches gate async continuations');
  assert(directoryDropSource.includes('discardStaleProjectOperation(requestedProjectPath, pendingOperation)'), 'move/import drops gate their terminal result');
  assert(/clipboardOperationSequenceRef\.current \+= 1;\s+setCutPaths\(\[\]\);\s+setClipboardPending\(false\);\s+setClipboardHasFiles\(false\);/.test(workspaceSource), 'project switches invalidate old clipboard continuations and let authoritative clipboard status repopulate UI');
  const inspirationSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'inspiration', 'InspirationLibrary.tsx'), 'utf8');
  assert(inspirationSource.includes('rootIdentityRef.current.generation + 1'), 'root identity generation changes when the library root changes');
  assert(/setPendingFolderMutation\(null\);\s+setRenamingPath\(''\);/.test(inspirationSource), 'root changes immediately clear pending and rename state');
  assert(/useLayoutEffect\(\(\) => \{\s+renameSubmittingRef\.current = false;/.test(inspirationSource), 'root cleanup runs before paint');
  assert((inspirationSource.match(/rootRequestIsCurrent\(requestedRootPath, requestedGeneration\)/g) || []).length >= 15, 'rename/create/delete continuations and finally blocks are identity gated');
  const renderEntryIconSource = workspaceSource.slice(workspaceSource.indexOf('const renderEntryIcon'), workspaceSource.indexOf('const entryHasPreviewState'));
  assert(!renderEntryIconSource.includes('Loader2'), 'new file-operation placeholders do not render a spinner');
  assert(!renderEntryIconSource.includes('pendingPlaceholder'), 'file-area rendering has no pending placeholder branch');
  assert(!workspaceSource.includes('pendingOperationLabel') && !workspaceSource.includes('pendingOperationKind') && !workspaceSource.includes('pendingPlaceholder'), 'file entries expose no processing label, kind, or placeholder visual state');
  const createFolderSource = workspaceSource.slice(workspaceSource.indexOf('const createFolder'), workspaceSource.indexOf('const loadShellNewTypes'));
  assert(!createFolderSource.includes('optimisticEntries:'), 'mkdir does not insert an entry through the pending overlay model');
  assert(createFolderSource.includes('upsertOptimisticDirectoryEntry(normalizedTarget, optimisticEntry)'), 'mkdir immediately shows a normal predicted final folder');
  assert(!workspaceSource.includes("name: '粘贴任务'") && !workspaceSource.includes("name: '导入任务'"), 'paste/import do not synthesize file-area task entries');
  const navigatorSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'ProjectNavigator.tsx'), 'utf8');
  assert(!navigatorSource.includes('{pendingProjectAction && <div role="status"'), 'project operations add no sidebar task widget');
  assert(!inspirationSource.includes('（处理中）'), 'the inspiration tree has no processing-name fake nodes');
  assert(!inspirationSource.includes("${busyPath === relativePath ? 'opacity-55' : ''}"), 'inspiration mutations do not gray real folder rows');

  console.log('file operation optimistic state model tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
