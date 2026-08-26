const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { directoryEntryToRevealOnReturn, fileEntryClickIntent, mergeRefreshedEntryMetadata, mutatedEntryCanBeRevealed, mutatedEntryFiltersNeedReset, remapEntryAfterProgressFolderMove, renamedEntryDestinationPath } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'file-entry-interaction-model.ts')).href);
  const { availableFolderAlphabetKeys, folderAlphabetKey } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'folder-alphabet-filter-model.ts')).href);
  const intent = overrides => fileEntryClickIntent({
    openMode: 'single',
    selectionCount: 0,
    range: false,
    additive: false,
    ...overrides,
  });

  assert.strictEqual(intent({ openMode: 'single' }), 'open', 'single-click mode opens when selection mode is inactive');
  assert.strictEqual(intent({ openMode: 'double' }), 'select', 'double-click mode selects on its first click');
  assert.strictEqual(intent({ openMode: 'single', selectionCount: 1 }), 'add-and-preview', 'an existing selection makes a plain body click add the entry and synchronize open preview panes in single-click mode');
  assert.strictEqual(intent({ openMode: 'double', selectionCount: 1 }), 'add-and-preview', 'an existing selection makes a plain body click add the entry and synchronize open preview panes in double-click mode');
  assert.strictEqual(intent({ additive: true }), 'toggle-select', 'Ctrl/Cmd click toggles selection without opening');
  assert.strictEqual(intent({ range: true, selectionCount: 2 }), 'range-select', 'Shift click retains range selection precedence');
  assert.strictEqual(intent({ selectionCount: 2, clickCount: 2 }), 'ignore-repeat', 'the second click in a double click must not undo the first selection change');

  assert.strictEqual(directoryEntryToRevealOnReturn('客户/婚礼/精修', '客户/婚礼'), '客户/婚礼/精修', 'returning one level reveals the folder that was just left');
  assert.strictEqual(directoryEntryToRevealOnReturn('客户/婚礼/精修', '客户'), '客户/婚礼', 'returning through a breadcrumb reveals the direct child leading to the previous directory');
  assert.strictEqual(directoryEntryToRevealOnReturn('客户/婚礼', ''), '客户', 'returning to the root reveals the top-level folder that was just left');
  assert.strictEqual(directoryEntryToRevealOnReturn('客户', '客户/婚礼'), '', 'entering a child directory does not request a return reveal');
  assert.strictEqual(directoryEntryToRevealOnReturn('客户/婚礼', '归档'), '', 'navigating to an unrelated directory does not request a return reveal');
  const workspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  assert(workspaceSource.includes('setDirectoryReturnHighlightPath(returnedFolder.relativePath)'), 'returning must mark the folder with a dedicated location highlight');
  assert(!workspaceSource.includes('setSelectedPaths([returnedFolder.relativePath])'), 'returning must not add the folder to the file-operation selection');
  assert(workspaceSource.includes('requestFileReveal(returnedFolder.relativePath)'), 'returning must scroll the folder back into view');
  const focusEntrySource = workspaceSource.slice(workspaceSource.indexOf('const focusEntry'), workspaceSource.indexOf('const activateMediaPreview'));
  assert(focusEntrySource.includes('setPreviewPath(entry.relativePath)') && !focusEntrySource.includes('setSelectedPaths') && !focusEntrySource.includes('selectionAnchorPathRef'), 'opening a preview must not silently select the previously previewed file');
  const entryClickSource = workspaceSource.slice(workspaceSource.indexOf('const handleEntryClick'), workspaceSource.indexOf('const handleEntryDoubleClick'));
  assert(entryClickSource.includes("if ('key' in event)") && entryClickSource.includes('activateEntry(entry)') && entryClickSource.includes("intent === 'add-and-preview'") && entryClickSource.includes('addSelectionAndSyncOpenPanes(entry)') && entryClickSource.includes("intent === 'select'") && entryClickSource.includes('setSelectedPaths([entry.relativePath])'), 'Enter must open in both modes, a selected-session body click must add and preview, and the first plain double-mode click must select exactly one entry');
  const entryDoubleClickSource = workspaceSource.slice(workspaceSource.indexOf('const handleEntryDoubleClick'), workspaceSource.indexOf('const handleFileSurfacePointerDownCapture'));
  assert(entryDoubleClickSource.includes('event.ctrlKey || event.metaKey || event.shiftKey') && entryDoubleClickSource.indexOf('return;') < entryDoubleClickSource.indexOf('activateEntry(entry)'), 'modified double-click gestures must remain selection-only instead of opening the entry');
  const inlineRenameSource = workspaceSource.slice(workspaceSource.indexOf('const renderEntryName'), workspaceSource.indexOf('const renderEntryIcon'));
  assert(inlineRenameSource.includes('onBlur={() => { void commitInlineRename(); }}'), 'clicking outside an inline rename input must commit the new name');
  assert(inlineRenameSource.includes("if (event.key === 'Escape') { event.preventDefault(); cancelInlineRename(); }"), 'Escape must continue to cancel an inline rename');
  const selectionControlSource = workspaceSource.slice(workspaceSource.indexOf('const renderEntrySelectionControl'), workspaceSource.indexOf('const startEntryDrag'));
  assert(selectionControlSource.includes('<button') && selectionControlSource.includes('aria-pressed={selected}') && selectionControlSource.includes('onPointerDown={event => event.stopPropagation()}') && selectionControlSource.includes("if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()") && selectionControlSource.includes('onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}') && selectionControlSource.includes('if (event.detail > 1) return;'), 'the selection control must isolate only its Enter/Space activation keys, allow file shortcuts such as Delete to bubble, and must not toggle twice or activate its parent on double-click');
  assert(workspaceSource.includes('fileMenuSelectionSnapshotRef') && workspaceSource.includes('fileMenuSelectionWasImplicitRef') && workspaceSource.includes('if (restoreSelection)') && workspaceSource.includes('openPreviewFromMenu(entry)'), 'explicit context-menu preview must restore any selection created only to target the context menu');
  const addAndPreviewSource = workspaceSource.slice(workspaceSource.indexOf('const addSelectionAndSyncOpenPanes'), workspaceSource.indexOf('const activateEntry'));
  assert(addAndPreviewSource.includes('setSelectedPaths(current => current.includes(entry.relativePath) ? current : [...current, entry.relativePath])') && addAndPreviewSource.includes('if (!previewPaneOpen && !metadataPaneOpen) return') && addAndPreviewSource.includes('if (previewPaneOpen) setPreviewMediaPath') && !addAndPreviewSource.includes('setPreviewPaneOpen'), 'selected-session body clicks must preserve existing selections and synchronize only panes that are already open');
  assert(!workspaceSource.includes('syncOpenPanesToSelection') && !workspaceSource.includes('clearPreviewAfterSelectionDrag'), 'generic selection operations must not move or clear the preview content cursor');
  const previewNavigationSource = workspaceSource.slice(workspaceSource.indexOf('const navigatePreviewMedia'), workspaceSource.indexOf('const displayedColumnWidths'));
  assert(previewNavigationSource.includes('setPreviewHighlightPath(nextEntry.relativePath)') && workspaceSource.includes('previewHighlightPath === entry.relativePath || directoryReturnHighlightPath === entry.relativePath'), 'preview navigation and directory return must share the one visual preview state');
  assert(workspaceSource.includes("querySelectorAll<HTMLElement>('[data-entry-path]')") && workspaceSource.includes('entryNode.focus({ preventScroll: true })'), 'preview navigation must move the real entry focus so only the native focus outline follows the preview');

  assert.strictEqual(renamedEntryDestinationPath('客户/旧文件夹', '新文件夹', [{
    sourceRelativePath: '客户\\旧文件夹',
    destinationRelativePath: '客户\\新文件夹 (1)',
  }]), '客户/新文件夹 (1)', 'rename selection must use the exact destination returned by the filesystem operation');
  assert.strictEqual(renamedEntryDestinationPath('客户/旧文件夹', '新文件夹'), '客户/新文件夹', 'rename selection retains a safe compatibility fallback when the backend omits move details');

  const openVersionEntry = {
    name: 'AKI_4147.jpg',
    path: 'D:\\照片流\\项目\\一修\\AKI_4147.jpg',
    relativePath: '一修/AKI_4147.jpg',
    previewUrl: 'media://stale-token',
  };
  const remappedVersionEntry = remapEntryAfterProgressFolderMove(openVersionEntry,
    { folderPath: 'D:\\照片流\\项目\\一修', relativePath: '一修' },
    { folderPath: 'D:\\照片流\\项目\\图片后期_1_一修', relativePath: '图片后期_1_一修' });
  assert.strictEqual(remappedVersionEntry.relativePath, '图片后期_1_一修/AKI_4147.jpg', 'an open version entry follows its stable progress node after the folder is renamed');
  assert.strictEqual(remappedVersionEntry.path, 'D:/照片流/项目/图片后期_1_一修/AKI_4147.jpg', 'the physical media path follows the renamed progress folder');
  assert.strictEqual(remappedVersionEntry.previewUrl, undefined, 'a path-bound preview authorization must not survive a folder move');
  assert.strictEqual(remapEntryAfterProgressFolderMove(openVersionEntry,
    { folderPath: 'D:\\照片流\\项目\\其他', relativePath: '其他' },
    { folderPath: 'D:\\照片流\\项目\\新名称', relativePath: '新名称' }), openVersionEntry, 'unrelated open entries must not be remapped');

  const mutationContext = {
    requestedProjectPath: 'D:/照片流/项目',
    currentProjectPath: 'D:/照片流/项目',
    mutationDirectoryPath: '客户/婚礼',
    currentDirectoryPath: '客户\\婚礼',
    browseMode: 'grid',
  };
  assert.strictEqual(mutatedEntryCanBeRevealed(mutationContext), true, 'a completed mutation remains revealable in its originating directory');
  assert.strictEqual(mutatedEntryCanBeRevealed({ ...mutationContext, currentDirectoryPath: '客户/写真' }), false, 'navigation during a mutation must not create a ghost selection in the new directory');
  assert.strictEqual(mutatedEntryCanBeRevealed({ ...mutationContext, currentProjectPath: 'D:/照片流/其他项目' }), false, 'a stale mutation must not select an entry after the page changes projects');
  assert.strictEqual(mutatedEntryCanBeRevealed({ ...mutationContext, browseMode: 'recent' }), false, 'a mutation target cannot be revealed in the recursive recent-files view');
  assert.strictEqual(mutatedEntryFiltersNeedReset({ searchQuery: '旧名称', fileFilter: 'all', ratingFilter: 'all', filterScope: 'current-folder' }), true, 'search text that can hide a renamed folder must be reset before reveal');
  assert.strictEqual(mutatedEntryFiltersNeedReset({ searchQuery: '', fileFilter: 'image', ratingFilter: 'all', filterScope: 'current-folder' }), true, 'a file-type filter that hides folders must be reset before reveal');
  assert.strictEqual(mutatedEntryFiltersNeedReset({ searchQuery: '', fileFilter: 'all', ratingFilter: 'all', filterScope: 'current-folder' }), false, 'an unfiltered current directory can reveal the target immediately');
  const refreshedMutationEntries = mergeRefreshedEntryMetadata([
    { relativePath: '客户/新建文件夹', size: -1, createdAt: 0, updatedAt: 0 },
    { relativePath: '客户/旧文件夹', size: -1, createdAt: 0, updatedAt: 0 },
  ], [{ relativePath: '客户/新建文件夹', size: 0, createdAt: 100, updatedAt: 200 }]);
  assert.deepStrictEqual(refreshedMutationEntries[0], { relativePath: '客户/新建文件夹', size: 0, createdAt: 100, updatedAt: 200 }, 'authoritative browse results must retain optimistic mutation metadata so date sorting cannot move the selected target twice');

  assert.strictEqual(folderAlphabetKey('Alice'), 'A', 'Latin folder names use their first letter');
  assert.strictEqual(folderAlphabetKey('崩坏'), 'B', 'Chinese folder names use their pinyin initial');
  assert.strictEqual(folderAlphabetKey('初音未来'), 'C', 'Chinese pinyin grouping covers later initials');
  assert.strictEqual(folderAlphabetKey('原神'), 'Y', 'Chinese pinyin grouping reaches the end of the alphabet');
  assert.strictEqual(folderAlphabetKey('  123'), '#', 'numeric and symbolic folder names share the fallback group');
  assert.deepStrictEqual(availableFolderAlphabetKeys(['原神', 'Alice', '崩坏', '123']), ['A', 'B', 'Y', '#']);

  console.log('File entry interaction model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
