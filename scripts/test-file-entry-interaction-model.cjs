const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { directoryEntryToRevealOnReturn, fileEntryClickIntent, fileEntryDragPaths, fileEntryPointerModifiers, fileEntrySelectionAfterDragStart, mergeRefreshedEntryMetadata, mergeRefreshedRecursiveDirectoryEntries, mutatedEntryCanBeRevealed, mutatedEntryFiltersNeedReset, ratingMutationPreviewIsCurrent, remapEntryAfterProgressFolderMove, renamedEntryDestinationPath, retainStableGroupOrder } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'file-entry-interaction-model.ts')).href);
  const { mergeMarqueeSelection } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'marquee-selection-model.ts')).href);
  const { mediaRatingCacheKey } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'file-entry-interaction-model.ts')).href);
  const { directoryPreviewCacheKey, directoryPreviewCacheKeyWithin, folderCoverEntryAfterLoad, pendingDirectoryPreviewSourceCacheKey, remapDirectoryPreviewCacheKey, remapPendingDirectoryPreviewEntries, settlePendingDirectoryPreviewRenameCaches, shouldCacheDirectoryPreviewResult } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'directory-preview-cache-model.ts')).href);
  const { FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES, createFolderCoverMediaState, folderCoverRequestKey, reduceFolderCoverMediaState } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'folder-cover-media-model.ts')).href);
  const { presentOfficeExtractionResult } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'office-extraction-result-model.ts')).href);
  const { availableFolderAlphabetKeys, folderAlphabetKey } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'folder-alphabet-filter-model.ts')).href);
  const intent = overrides => fileEntryClickIntent({
    openMode: 'single',
    selectionCount: 0,
    entrySelected: false,
    range: false,
    additive: false,
    ...overrides,
  });
  assert.equal(ratingMutationPreviewIsCurrent(3, 3, 'A|1', 'A|1'), true, 'the current rating mutation may update its own preview');
  assert.equal(ratingMutationPreviewIsCurrent(3, 4, 'A|1', 'B|1'), false, 'a late A result cannot update B preview even though A entity caches still commit');
  assert.equal(mediaRatingCacheKey('C:\\Photos/MIXED\\A.JPG', 9), mediaRatingCacheKey('c:/photos/mixed/a.jpg', 9), 'Windows rating keys normalize mixed slashes and case consistently');

  assert.strictEqual(intent({ openMode: 'single' }), 'open', 'single-click mode opens when selection mode is inactive');
  assert.strictEqual(intent({ openMode: 'double' }), 'select', 'double-click mode selects on its first click');
  assert.strictEqual(intent({ openMode: 'single', selectionCount: 1 }), 'add-and-preview', 'an existing selection makes a plain body click add the entry and synchronize open preview panes in single-click mode');
  assert.strictEqual(intent({ openMode: 'double', selectionCount: 1 }), 'add-and-preview', 'an existing selection makes a plain body click add the entry and synchronize open preview panes in double-click mode');
  assert.strictEqual(intent({ selectionCount: 1, entrySelected: true }), 'toggle-select', 'plain-clicking a selected entry again removes it from the active selection');
  assert.strictEqual(intent({ selectionCount: 3, entrySelected: true }), 'toggle-select', 'plain-clicking one member of a multi-selection removes only that entry');
  assert.strictEqual(intent({ additive: true }), 'toggle-select', 'Ctrl/Cmd click toggles selection without opening');
  assert.strictEqual(intent({ range: true, selectionCount: 2 }), 'range-select', 'Shift click retains range selection precedence');
  assert.strictEqual(intent({ selectionCount: 2, clickCount: 2 }), 'ignore-repeat', 'the second click in a double click must not undo the first selection change');

  const runPointerClickSequence = ({ surface, openMode, initialSelection = [], detail = 1 }) => {
    let selection = [...initialSelection];
    const pointer = fileEntryPointerModifiers({ path: '素材/照片.jpg', pointerType: 'mouse' });
    assert.deepStrictEqual(selection, initialSelection, `${surface} pointerdown must survive a React flush without mutating selection`);
    const clickIntent = fileEntryClickIntent({
      openMode,
      selectionCount: selection.length,
      entrySelected: selection.includes(pointer.path),
      range: pointer.range,
      additive: pointer.additive,
      clickCount: detail,
    });
    if (clickIntent === 'select') selection = [pointer.path];
    return { clickIntent, selection, activated: clickIntent === 'open' };
  };
  for (const surface of ['grid', 'list', 'version-tree']) {
    assert.deepStrictEqual(runPointerClickSequence({ surface, openMode: 'single' }), {
      clickIntent: 'open', selection: [], activated: true,
    }, `${surface} pointerdown -> React flush -> click must activate instead of add-and-preview`);
    const selectionAfterCancelledDrag = fileEntrySelectionAfterDragStart([], '素材/照片.jpg', ['素材/照片.jpg']);
    assert.deepStrictEqual(runPointerClickSequence({ surface, openMode: 'single', initialSelection: selectionAfterCancelledDrag }), {
      clickIntent: 'open', selection: [], activated: true,
    }, `${surface} empty selection -> unselected dragstart -> cancel -> click must still activate`);
  }
  const doubleFirst = runPointerClickSequence({ surface: 'grid', openMode: 'double' });
  assert.deepStrictEqual(doubleFirst, { clickIntent: 'select', selection: ['素材/照片.jpg'], activated: false }, 'double mode first click selects without activating');
  assert.strictEqual(fileEntryClickIntent({ openMode: 'double', selectionCount: doubleFirst.selection.length, entrySelected: true, range: false, additive: false, clickCount: 2 }), 'ignore-repeat', 'double mode second click leaves activation to the double-click handler');

  assert.deepStrictEqual(mergeMarqueeSelection([], ['a.jpg'], false), ['a.jpg'], 'a marquee from no selection selects its hits');
  assert.deepStrictEqual(mergeMarqueeSelection(['a.jpg'], [], false), [], 'a non-additive marquee can clear an existing selection');
  assert.deepStrictEqual(mergeMarqueeSelection(['a.jpg', 'b.jpg'], ['c.jpg'], true), ['a.jpg', 'b.jpg', 'c.jpg'], 'an additive marquee preserves a multi-selection and adds hits');
  assert.deepStrictEqual(fileEntrySelectionAfterDragStart([], 'a.jpg', []), [], 'pointerdown or a rejected dragstart cannot select an entry');
  assert.deepStrictEqual(fileEntrySelectionAfterDragStart([], 'a.jpg', ['a.jpg']), [], 'a successful native dragstart keeps an unselected target out of persistent selection');
  assert.deepStrictEqual(fileEntrySelectionAfterDragStart(['a.jpg'], 'a.jpg', ['a.jpg']), ['a.jpg'], 'dragging a selected target preserves that selection');
  assert.deepStrictEqual(fileEntrySelectionAfterDragStart(['a.jpg', 'b.jpg'], 'a.jpg', ['a.jpg', 'b.jpg']), ['a.jpg', 'b.jpg'], 'dragging one selected item preserves the selected group');
  assert.deepStrictEqual(fileEntryDragPaths('unsupported.lnk/item.jpg', ['unsupported.lnk/item.jpg', 'actual-first.jpg', 'actual-second.jpg'], path => path.startsWith('unsupported.lnk/')), {
    requestedPaths: ['unsupported.lnk/item.jpg', 'actual-first.jpg', 'actual-second.jpg'],
    dragPaths: ['actual-first.jpg', 'actual-second.jpg'],
  }, 'an unsupported first selected entry is removed while the actual draggable order is preserved for prewarm and start');
  assert.deepStrictEqual(fileEntryDragPaths('unsupported.lnk/item.jpg', [], path => path.startsWith('unsupported.lnk/')).dragPaths, [], 'an unselected unsupported entry has no prewarm or drag source');
  assert.deepStrictEqual(fileEntryDragPaths('outside-selection.jpg', ['selected.jpg'], () => false), {
    requestedPaths: ['outside-selection.jpg'], dragPaths: ['outside-selection.jpg'],
  }, 'dragging an unselected entry does not inherit the unrelated selection');

  assert.strictEqual(directoryEntryToRevealOnReturn('客户/婚礼/精修', '客户/婚礼'), '客户/婚礼/精修', 'returning one level reveals the folder that was just left');
  assert.strictEqual(directoryEntryToRevealOnReturn('客户/婚礼/精修', '客户'), '客户/婚礼', 'returning through a breadcrumb reveals the direct child leading to the previous directory');
  assert.strictEqual(directoryEntryToRevealOnReturn('客户/婚礼', ''), '客户', 'returning to the root reveals the top-level folder that was just left');
  assert.strictEqual(directoryEntryToRevealOnReturn('客户', '客户/婚礼'), '', 'entering a child directory does not request a return reveal');
  assert.strictEqual(directoryEntryToRevealOnReturn('客户/婚礼', '归档'), '', 'navigating to an unrelated directory does not request a return reveal');
  const workspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const fileEntryVisualsSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'FileEntryVisuals.tsx'), 'utf8');
  assert(workspaceSource.includes('mergeRefreshedRecursiveDirectoryEntries(current, nextDirectoryEntries, directoryPath)'), 'recursive folder refreshes must preserve retained metadata instead of resetting the group sort key');
  assert(workspaceSource.includes('retainStableGroupOrder(recursiveGroupOrderRef.current.paths'), 'all-files folder groups must retain their established visual order across incremental refreshes');
  const toolAvailabilitySource = workspaceSource.slice(workspaceSource.indexOf('const canExtractScreenshotMainImage'), workspaceSource.indexOf('const projectToolbarAvailability'));
  assert(!toolAvailabilitySource.includes('!selectedContainsShortcutContent'), 'media-processing tools must accept media reached through external links and inspiration shortcuts');
  const photoshopOpenSource = workspaceSource.slice(workspaceSource.indexOf('const openProjectEntriesInPhotoshop'), workspaceSource.indexOf('const copyEntryPath'));
  assert(!photoshopOpenSource.includes('viaShortcut'), 'Photoshop opening must delegate shortcut validation to the trusted backend resolver');
  const normalOfficeResult = presentOfficeExtractionResult({ success: true, documentCount: 1, successfulCount: 1, imageCount: 2, results: [{ document: 'C:/项目/方案.docx', documentName: '方案.docx', success: true, count: 2, outputFolder: 'C:/项目/方案_media', publishSuccess: true }] }, 1);
  assert.strictEqual(normalOfficeResult.state, 'success');
  const partialOfficeResult = presentOfficeExtractionResult({ success: true, documentCount: 2, successfulCount: 1, failedCount: 1, imageCount: 2, results: [{ document: 'ok.docx', documentName: 'ok.docx', success: true, count: 2, outputFolder: 'ok_media' }, { document: 'bad.docx', documentName: 'bad.docx', success: false, count: 0, error: '文档损坏' }] }, 2);
  assert.strictEqual(partialOfficeResult.state, 'partial');
  assert.deepStrictEqual(partialOfficeResult.extractionFailures, [{ documentName: 'bad.docx', error: '文档损坏' }]);
  const publicationFailure = presentOfficeExtractionResult({ success: false, error: '已提取但链接发布失败', results: [{ document: '方案.docx', documentName: '方案.docx', success: true, count: 2, outputFolder: 'C:/项目/方案_media', publishSuccess: false, publishError: '快捷方式写入失败' }] }, 1);
  assert.strictEqual(publicationFailure.state, 'publication-failed');
  const mixedPublication = presentOfficeExtractionResult({ success: false, error: 'aggregate publish failure', results: [{ document: 'published.docx', documentName: 'published.docx', success: true, count: 1, publishSuccess: true }, { document: 'unknown.docx', documentName: 'unknown.docx', success: true, count: 1 }] }, 2);
  assert.deepStrictEqual(mixedPublication.publicationFailures.map(item => item.documentName), ['unknown.docx'], 'aggregate failure must preserve explicitly published items and infer failure only for the rest');
  assert.strictEqual(publicationFailure.publicationFailures[0].outputFolder, 'C:/项目/方案_media');
  assert.strictEqual(presentOfficeExtractionResult({ success: false, error: '提取失败', results: [] }, 1), null, 'an authoritative extraction failure must remain a retryable failure state');
  const authoritativeEmpty = presentOfficeExtractionResult({ success: true, documentCount: 1, successfulCount: 1, imageCount: 0, results: [{ document: '空.xlsx', documentName: '空.xlsx', success: true, count: 0, message: '文档中没有图片' }] }, 1);
  assert.strictEqual(authoritativeEmpty.state, 'success');
  assert.strictEqual(authoritativeEmpty.images, 0);
  assert(workspaceSource.includes('图片已提取，但发布失败') && workspaceSource.includes('恢复目录：') && workspaceSource.includes('请勿盲目重试提取'), 'the mounted Office result panel must visibly distinguish recoverable publication failure from extraction failure');
  assert(workspaceSource.includes('directoryPreviewRequestTokensRef.current.get(cacheKey) !== requestToken'), 'late directory preview requests must be rejected after rename cache settlement invalidates their token');
  assert(workspaceSource.includes('settleDirectoryPreviewRenames([optimisticRenameEntry], true)') && workspaceSource.includes('settleDirectoryPreviewRenames([optimisticRenameEntry], false)'), 'single-folder rename must explicitly promote or roll back its directory preview cache');
  assert(fileEntryVisualsSource.includes('pendingRename || !result.authoritative') && workspaceSource.includes('return { entries: [], authoritative: false }'), 'a transient directory read failure must retain the mounted cover instead of masquerading as an authoritative empty folder');
  assert(workspaceSource.includes('optimisticDirectoryEntriesCacheRef.current.set(cacheKey, remapped)') && workspaceSource.includes('if (pendingRename) return Promise.resolve({ entries: [], authoritative: false })'), 'optimistic rename previews must stay isolated from authoritative source caches and never browse a swap target before commit');
  assert(workspaceSource.includes('setDirectoryReturnHighlightPath(returnedFolder.relativePath)'), 'returning must mark the folder with a dedicated location highlight');
  assert(!workspaceSource.includes('setSelectedPaths([returnedFolder.relativePath])'), 'returning must not add the folder to the file-operation selection');
  assert(workspaceSource.includes('requestFileReveal(returnedFolder.relativePath)'), 'returning must scroll the folder back into view');
  const focusEntrySource = workspaceSource.slice(workspaceSource.indexOf('const focusEntry'), workspaceSource.indexOf('const activateMediaPreview'));
  assert(focusEntrySource.includes('setPreviewPath(entry.relativePath)') && !focusEntrySource.includes('setSelectedPaths') && !focusEntrySource.includes('selectionAnchorPathRef'), 'opening a preview must not silently select the previously previewed file');
  const entryClickSource = workspaceSource.slice(workspaceSource.indexOf('const handleEntryClick'), workspaceSource.indexOf('const handleEntryDoubleClick'));
  assert(entryClickSource.includes("if ('key' in event)") && entryClickSource.includes('activateEntry(entry)') && entryClickSource.includes("intent === 'add-and-preview'") && entryClickSource.includes('addSelectionAndSyncOpenPanes(entry)') && entryClickSource.includes("intent === 'select'") && entryClickSource.includes('setSelectedPaths([entry.relativePath])'), 'Enter must open in both modes, a selected-session body click must add and preview, and the first plain double-mode click must select exactly one entry');
  const entryDoubleClickSource = workspaceSource.slice(workspaceSource.indexOf('const handleEntryDoubleClick'), workspaceSource.indexOf('const handleFileSurfacePointerDownCapture'));
  assert(entryDoubleClickSource.includes('event.ctrlKey || event.metaKey || event.shiftKey') && entryDoubleClickSource.indexOf('return;') < entryDoubleClickSource.indexOf('activateEntry(entry)'), 'modified double-click gestures must remain selection-only instead of opening the entry');
  const pointerCaptureSource = workspaceSource.slice(workspaceSource.indexOf('const handleFileSurfacePointerDownCapture'), workspaceSource.indexOf('const getEntryDisplayName'));
  assert(pointerCaptureSource.includes('fileEntryPointerModifiers({') && pointerCaptureSource.includes('target?.focus({ preventScroll: true })') && !pointerCaptureSource.includes('setSelectedPaths'), 'pointerdown capture may focus and record modifiers/pointer type, but must never mutate selection');
  const dragStartSource = workspaceSource.slice(workspaceSource.indexOf('const startEntryDrag'), workspaceSource.indexOf('const finishEntryDrag'));
  assert(!dragStartSource.includes('setSelectedPaths') && !dragStartSource.includes('fileEntrySelectionAfterDragStart'), 'native dragstart must not commit a transient drag target into persistent selection');
  assert(!dragStartSource.includes('setNativeDraggingRelativePath') && !dragStartSource.includes('data-native-file-dragging'), 'native dragstart must not trigger a React visual update before the OS handoff');
  const versionEntryStart = workspaceSource.indexOf('const renderVersionTreeEntry');
  const versionEntrySource = workspaceSource.slice(versionEntryStart, workspaceSource.indexOf('const progressCompareCandidates', versionEntryStart));
  for (const handler of ['onClick={event => handleEntryClick(event, entry)}', 'onDoubleClick={event => handleEntryDoubleClick(event, entry)}']) assert(versionEntrySource.includes(handler), `version-tree entries must wire ${handler}`);
  for (const layoutMarker of ['searchResultGroups.map', "viewMode === 'list'", 'renderedFileEntries.map']) assert(workspaceSource.includes(layoutMarker), `${layoutMarker} file surface must remain mounted`);
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

  const cachedCoverEntry = {
    name: '封面.jpg', kind: 'image', extension: '.jpg', size: 42, createdAt: 10, updatedAt: 20,
    relativePath: '客户/旧版本/子目录/封面.jpg', parentRelativePath: '客户/旧版本/子目录',
    path: 'D:\\项目\\客户\\旧版本\\子目录\\封面.jpg', previewUrl: 'photoflow-media://file/stable-thumbnail-grant', rating: 5,
  };
  const pendingFolderRename = {
    name: '新版本', kind: 'folder', extension: '', size: 0, createdAt: 1, updatedAt: 2,
    relativePath: '客户/新版本', path: 'D:\\项目\\客户\\新版本', pendingSourceRelativePath: '客户\\旧版本',
  };
  const [remappedCoverEntry] = remapPendingDirectoryPreviewEntries(pendingFolderRename, [cachedCoverEntry]);
  assert.deepStrictEqual({ relativePath: remappedCoverEntry.relativePath, parentRelativePath: remappedCoverEntry.parentRelativePath, path: remappedCoverEntry.path }, {
    relativePath: '客户/新版本/子目录/封面.jpg', parentRelativePath: '客户/新版本/子目录', path: 'D:/项目/客户/新版本/子目录/封面.jpg',
  }, 'pending rename preview cache remaps nested relative and physical paths across slash styles and casing');
  assert.strictEqual(remappedCoverEntry.previewUrl, cachedCoverEntry.previewUrl, 'pending rename preview cache preserves the existing thumbnail grant');
  assert.strictEqual(remappedCoverEntry.rating, 5, 'pending rename preview cache preserves media metadata');
  const similarPrefixEntry = { ...cachedCoverEntry, relativePath: '客户/旧版本备份/封面.jpg', path: 'D:/项目/客户/旧版本备份/封面.jpg' };
  assert.strictEqual(remapPendingDirectoryPreviewEntries(pendingFolderRename, [similarPrefixEntry])[0], similarPrefixEntry, 'similar directory prefixes are not rewritten as children');
  const unrelatedPhysicalEntry = { ...cachedCoverEntry, path: 'D:/项目/客户/别处/封面.jpg' };
  assert.strictEqual(remapPendingDirectoryPreviewEntries(pendingFolderRename, [unrelatedPhysicalEntry])[0], unrelatedPhysicalEntry, 'a matching virtual route cannot rewrite an unrelated physical path');
  const externalRename = {
    ...pendingFolderRename, kind: 'shortcut', externalLink: true, externalLinkTarget: 'E:\\外链素材\\RAW', externalLinkTargetKind: 'folder',
    relativePath: '外链新名.lnk', pendingSourceRelativePath: '外链旧名.lnk', path: 'D:/项目/外链新名.lnk',
  };
  const externalChild = { ...cachedCoverEntry, relativePath: '外链旧名.lnk/封面.jpg', parentRelativePath: '外链旧名.lnk', path: 'e:/外链素材/raw/封面.jpg' };
  const [remappedExternalChild] = remapPendingDirectoryPreviewEntries(externalRename, [externalChild]);
  assert.strictEqual(remappedExternalChild.relativePath, '外链新名.lnk/封面.jpg', 'external-link cache remaps its virtual route');
  assert.strictEqual(remappedExternalChild.parentRelativePath, '外链新名.lnk', 'external-link cache remaps an immediate child parent route');
  assert.strictEqual(remappedExternalChild.path, 'E:/外链素材/RAW/封面.jpg', 'external-link cache keeps the authoritative physical target route');
  assert.strictEqual(remappedExternalChild.previewUrl, externalChild.previewUrl, 'external-link cache keeps its preview URL');
  assert.strictEqual(directoryPreviewCacheKey(externalRename), '外链新名.lnk');
  assert.strictEqual(pendingDirectoryPreviewSourceCacheKey(externalRename), '外链旧名.lnk');
  assert.strictEqual(shouldCacheDirectoryPreviewResult(true, { success: false, entries: [] }), false, 'a first pending-path browse failure cannot poison the cache');
  assert.strictEqual(shouldCacheDirectoryPreviewResult(true, { success: true, entries: [] }), false, 'a transient pending-path empty result cannot poison the cache');
  assert.strictEqual(shouldCacheDirectoryPreviewResult(true, { success: true, entries: [remappedCoverEntry] }), true, 'a successful pending-path browse can replace the remapped cache');
  assert.strictEqual(shouldCacheDirectoryPreviewResult(false, { success: false, entries: [] }), false, 'an ordinary transient browse failure cannot poison a reusable directory cache key');
  assert.strictEqual(shouldCacheDirectoryPreviewResult(false, { success: true, entries: [] }), true, 'an authoritative ordinary empty folder remains cacheable');
  assert.strictEqual(folderCoverEntryAfterLoad(cachedCoverEntry, [], true), cachedCoverEntry, 'pending rename empty results retain the mounted folder cover');
  assert.strictEqual(folderCoverEntryAfterLoad(cachedCoverEntry, [], false), undefined, 'an authoritative ordinary empty result clears the cover');
  let coverMedia = createFolderCoverMediaState('old-source|42|20|320', 'photoflow-media://old-cover');
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'CANDIDATE_LOADED', url: 'photoflow-media://old-cover' });
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'SOURCE_UPDATED', sourceKey: 'renamed-source|42|20|320', preserveDisplayed: true });
  assert.strictEqual(coverMedia.displayedUrl, 'photoflow-media://old-cover', 'a renamed media path with no authoritative preview yet keeps its loaded cover');
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'THUMBNAIL_UPDATED', state: 'STALE' });
  assert.strictEqual(coverMedia.displayedUrl, 'photoflow-media://old-cover', 'a pending rename STALE update does not blank the loaded cover');
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'THUMBNAIL_UPDATED', state: 'READY', previewUrl: 'photoflow-media://new-cover' });
  assert.strictEqual(coverMedia.displayedUrl, 'photoflow-media://old-cover', 'a READY replacement remains hidden until the browser loads it successfully');
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'CANDIDATE_LOADED', url: 'photoflow-media://new-cover' });
  assert.strictEqual(coverMedia.displayedUrl, 'photoflow-media://new-cover', 'a successfully loaded READY replacement swaps in seamlessly');
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'THUMBNAIL_UPDATED', state: 'READY', previewUrl: 'photoflow-media://bad-cover?token=1' });
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'CANDIDATE_FAILED', url: 'photoflow-media://bad-cover?token=1' });
  assert.strictEqual(coverMedia.displayedUrl, 'photoflow-media://new-cover', 'a bad never-loaded replacement cannot poison the displayed cover');
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'THUMBNAIL_UPDATED', state: 'READY', previewUrl: 'photoflow-media://bad-cover?token=2' });
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'CANDIDATE_FAILED', url: 'photoflow-media://bad-cover?token=2' });
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'THUMBNAIL_UPDATED', state: 'READY', previewUrl: 'photoflow-media://bad-cover?token=3' });
  assert.strictEqual(coverMedia.candidateUrl, undefined, 'fresh authorization tokens cannot bypass the per-source load failure budget');
  assert.strictEqual(coverMedia.consecutiveLoadFailures, FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES, 'the bounded failure state has constant memory instead of retaining every expired token');
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'THUMBNAIL_UPDATED', state: 'STALE' });
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'THUMBNAIL_UPDATED', state: 'READY', previewUrl: 'photoflow-media://recovered-cover' });
  coverMedia = reduceFolderCoverMediaState(coverMedia, { type: 'CANDIDATE_LOADED', url: 'photoflow-media://recovered-cover' });
  assert.strictEqual(coverMedia.displayedUrl, 'photoflow-media://recovered-cover', 'a new thumbnail generation receives a fresh bounded budget and can recover');
  assert.notStrictEqual(folderCoverRequestKey('renamed-source|42|20|320', true, 0), folderCoverRequestKey('renamed-source|42|20|320', false, 0), 'pending-to-committed transition must trigger an authoritative thumbnail request even when the target path is unchanged');
  const committedRenameCaches = new Map([[pendingDirectoryPreviewSourceCacheKey(pendingFolderRename), [cachedCoverEntry]]]);
  const committedOptimisticCaches = new Map();
  const committedSettlement = settlePendingDirectoryPreviewRenameCaches(committedRenameCaches, committedOptimisticCaches, [pendingFolderRename], true);
  assert.strictEqual(committedRenameCaches.get('客户/新版本')[0].relativePath, '客户/新版本/子目录/封面.jpg', 'successful rename promotes a remapped target cache');
  assert.strictEqual(committedRenameCaches.has('客户/旧版本'), false, 'successful rename retires the stale source route');
  assert.deepStrictEqual(committedSettlement.invalidatedRequestRoots, ['客户/旧版本', '客户/新版本'], 'commit invalidates both stale source reads and target reads started before the filesystem rename');
  const rolledBackRenameCaches = new Map([[pendingDirectoryPreviewSourceCacheKey(pendingFolderRename), [cachedCoverEntry]]]);
  const rolledBackOptimisticCaches = new Map([[directoryPreviewCacheKey(pendingFolderRename), [remappedCoverEntry]]]);
  const rolledBackSettlement = settlePendingDirectoryPreviewRenameCaches(rolledBackRenameCaches, rolledBackOptimisticCaches, [pendingFolderRename], false);
  assert.strictEqual(rolledBackRenameCaches.get('客户/旧版本')[0], cachedCoverEntry, 'rollback retains the authoritative source cache and cover');
  assert.strictEqual(rolledBackRenameCaches.has('客户/新版本'), false, 'rollback removes the optimistic target so later name reuse cannot show the wrong cover');
  assert.strictEqual(rolledBackOptimisticCaches.has('客户/新版本'), false, 'rollback discards the isolated optimistic overlay');
  assert.deepStrictEqual(rolledBackSettlement.invalidatedRequestRoots, ['客户/新版本'], 'rollback invalidates every late target request');

  const cacheCover = (folder, token) => ({
    ...cachedCoverEntry,
    name: `${token}.jpg`, relativePath: `${folder}/${token}.jpg`, parentRelativePath: folder,
    path: `D:/项目/${folder}/${token}.jpg`, previewUrl: `photoflow-media://${token}`,
  });
  const pendingRootRename = (source, target) => ({
    ...pendingFolderRename,
    name: target, relativePath: target, path: `D:/项目/${target}`, pendingSourceRelativePath: source,
  });
  const swapCaches = new Map([['A', [cacheCover('A', 'cover-a')]], ['B', [cacheCover('B', 'cover-b')]]]);
  settlePendingDirectoryPreviewRenameCaches(swapCaches, new Map(), [pendingRootRename('A', 'B'), pendingRootRename('B', 'A')], true);
  assert.strictEqual(swapCaches.get('A')[0].previewUrl, 'photoflow-media://cover-b', 'A/B swap atomically moves B cover to A');
  assert.strictEqual(swapCaches.get('B')[0].previewUrl, 'photoflow-media://cover-a', 'A/B swap atomically moves A cover to B');
  const overlaySwapCaches = new Map([['A', [cacheCover('A', 'cover-a')]], ['B', [cacheCover('B', 'cover-b')]]]);
  const overlaySwapEntries = [pendingRootRename('A', 'B'), pendingRootRename('B', 'A')];
  const overlaySwap = new Map([
    ['B', remapPendingDirectoryPreviewEntries(overlaySwapEntries[0], overlaySwapCaches.get('A'))],
    ['A', remapPendingDirectoryPreviewEntries(overlaySwapEntries[1], overlaySwapCaches.get('B'))],
  ]);
  settlePendingDirectoryPreviewRenameCaches(overlaySwapCaches, overlaySwap, overlaySwapEntries, true);
  assert.deepStrictEqual([overlaySwapCaches.get('A')[0].previewUrl, overlaySwapCaches.get('B')[0].previewUrl], [
    'photoflow-media://cover-b', 'photoflow-media://cover-a',
  ], 'non-empty optimistic overlays preserve swap direction when atomically promoted');
  const cycleCaches = new Map([
    ['A', [cacheCover('A', 'cover-a')]], ['B', [cacheCover('B', 'cover-b')]], ['C', [cacheCover('C', 'cover-c')]],
    ['A/subdir', [cacheCover('A/subdir', 'nested-a')]],
    ['shortcut:A/tool.lnk:20', [cacheCover('A/tool.lnk', 'shortcut-a')]],
  ]);
  settlePendingDirectoryPreviewRenameCaches(cycleCaches, new Map(), [pendingRootRename('A', 'B'), pendingRootRename('B', 'C'), pendingRootRename('C', 'A')], true);
  assert.deepStrictEqual([cycleCaches.get('A')[0].previewUrl, cycleCaches.get('B')[0].previewUrl, cycleCaches.get('C')[0].previewUrl], [
    'photoflow-media://cover-c', 'photoflow-media://cover-a', 'photoflow-media://cover-b',
  ], 'three-directory rename cycles read every source from one immutable snapshot');
  assert.strictEqual(cycleCaches.get('B/subdir')[0].previewUrl, 'photoflow-media://nested-a', 'rename settlement migrates loaded child-directory caches by path segment prefix');
  assert.strictEqual(cycleCaches.get('shortcut:B/tool.lnk:20')[0].previewUrl, 'photoflow-media://shortcut-a', 'rename settlement migrates shortcut preview caches nested under the renamed directory');
  assert.strictEqual(cycleCaches.has('A/subdir'), false, 'successful settlement retires old child-directory cache prefixes');
  assert.strictEqual(directoryPreviewCacheKeyWithin('A-backup', 'A'), false, 'prefix invalidation never mistakes a similar sibling name for a child path');
  assert.strictEqual(directoryPreviewCacheKeyWithin('shortcut:A/subdir/tool.lnk:20', 'A'), true, 'shortcut preview keys inside a renamed subtree participate in prefix invalidation');
  assert.strictEqual(remapDirectoryPreviewCacheKey('shortcut:A/subdir/tool.lnk:20', 'A', 'B'), 'shortcut:B/subdir/tool.lnk:20', 'nested shortcut preview keys preserve their timestamp identity while the virtual path moves');

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
  const recursiveEntries = mergeRefreshedRecursiveDirectoryEntries([
    { relativePath: '固定/保留.jpg', parentRelativePath: '固定', size: 10, createdAt: 100, updatedAt: 500 },
    { relativePath: '刷新/原图.jpg', parentRelativePath: '刷新', size: 20, createdAt: 200, updatedAt: 400 },
    { relativePath: '刷新/已删除.jpg', parentRelativePath: '刷新', size: 30, createdAt: 300, updatedAt: 300, viaShortcut: true },
  ], [
    { relativePath: '刷新/原图.jpg', parentRelativePath: '刷新', size: -1, createdAt: 0, updatedAt: 0 },
    { relativePath: '刷新/新增.jpg', parentRelativePath: '刷新', size: -1, createdAt: 0, updatedAt: 0 },
  ], '刷新');
  assert.deepStrictEqual(recursiveEntries, [
    { relativePath: '固定/保留.jpg', parentRelativePath: '固定', size: 10, createdAt: 100, updatedAt: 500 },
    { relativePath: '刷新/原图.jpg', parentRelativePath: '刷新', size: 20, createdAt: 200, updatedAt: 400 },
    { relativePath: '刷新/新增.jpg', parentRelativePath: '刷新', size: -1, createdAt: 0, updatedAt: 0 },
  ], 'a recursive directory refresh must atomically replace only that folder, retain metadata for surviving files, and remove deleted shortcut descendants');
  assert.deepStrictEqual(retainStableGroupOrder(['根目录', '刷新', '末尾'], ['刷新', '根目录', '新增']), ['根目录', '刷新', '末尾', '新增'], 'known folder positions survive refresh-time timestamp changes while new groups append without displacing them');

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
