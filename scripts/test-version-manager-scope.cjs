const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'VersionManager.tsx'), 'utf8');
  const workspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const mediaIpcSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'modules', 'media-ipc.cjs'), 'utf8');
  assert(/kind === 'raw'\s*\? window\.electronAPI\.getMediaOriginal/.test(source), 'RAW version previews must obtain the rendered source and orientation from the same IPC result');
  assert(source.includes('aria-expanded={open}') && source.includes('openMetadataGroups'), 'version metadata groups must use explicit controlled buttons');
  assert(source.includes('const branchPhotoRequestRef = useRef(0)') && !source.includes('disabled={branchPhotoLoading} aria-pressed={activePhotoId'), 'branch photos must remain clickable while another photo request is pending');
  assert(source.includes('const loadRequestRef = useRef(0)') && source.includes('requestId !== loadRequestRef.current'), 'stale version-load responses must not overwrite a newer entry');
  assert(source.includes('const pageGenerationRef = useRef(0)') && (source.match(/runMutation\(pageGeneration/g) || []).length >= 5, 'every committed version write must use the shared finally-backed busy lifecycle');
  const busyLifecycleSource = source.slice(source.indexOf('const runMutation = async'), source.indexOf('const publishCommittedMutation ='));
  assert(busyLifecycleSource.includes('try {') && busyLifecycleSource.includes('finally {') && busyLifecycleSource.includes('settleMutationBusy(pageGeneration)'), 'the shared mutation lifecycle must settle both busy representations in finally');
  assert(source.includes('const selectBranchPhoto = async') && source.includes('const pageGeneration = ++pageGenerationRef.current') && source.includes('selectBranchPhoto(photo.photoId)'), 'switching the active main-branch photo must start a new page generation');
  for (const marker of ['updateMediaVersion(workspacePath, request)', 'deleteProjectMissingMediaVersion(workspacePath, version.id)', 'deleteMediaVersion(workspacePath', 'relocateMediaVersion(workspacePath']) {
    const index = source.indexOf(marker);
    assert(index >= 0 && source.slice(Math.max(0, index - 100), index + 700).includes('runMutation(pageGeneration'), `${marker} must use the finally-backed busy lifecycle`);
  }
  const deleteScopeIndex = source.indexOf('getMediaVersionDeleteScope(workspacePath, version.id)');
  assert(deleteScopeIndex >= 0 && source.slice(deleteScopeIndex, deleteScopeIndex + 500).includes('pageGenerationIsCurrent(pageGeneration)'), 'delete-scope preflight must ignore an older page generation');
  assert(source.includes("setBundle({ ...result, versions: [] })") && source.includes("setSelectedId('')") && source.includes("setCompareIds([])"), 'a failed version load must clear the prior entry instead of leaving stale media visible');
  assert(source.includes('orientation="horizontal" label="调整主分支图片列表高度"') && source.includes("document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'") && source.includes("window.addEventListener('pointermove', move)"), 'version-manager splitters must support robust horizontal and vertical window-level dragging');
  assert(source.includes('onSaveNote={note => updateVersion') && source.includes('保存说明') && !source.includes('编辑版本说明'), 'the selected version note must be editable directly in the details pane');
  assert(!source.includes('版本管理不保存文件副本。被覆盖或永久删除的内容无法恢复。'), 'the redundant version-copy warning must not occupy the branch panel');
  assert(workspaceSource.includes("const [versionProgressId, setVersionProgressId] = useState('')") && workspaceSource.includes('entry={renderedVersionEntry}') && workspaceSource.includes('progressId={versionProgressFolder?.id || versionProgressId}') && workspaceSource.includes('versionProgressId === existingProgress.id'), 'an open version page must retain its stable progress identity and render the media path remapped to the current folder');
  assert(source.includes('className="absolute inset-0 z-0 cursor-pointer rounded-xl'), 'each version card must expose a real full-card preview button');
  assert(mediaIpcSource.includes('const orientation = await rawOrientationCorrection(sourcePath, previewPath, stat);') && !mediaIpcSource.includes('orientationTimer = setTimeout'), 'slow RAW orientation reads must not silently fall back to an incorrect identity transform');
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'versioning', 'version-manager-model.ts')).href);
  const version = (id, createdAt, fileMissing = false) => ({ id, photoId: 'photo-a', versionNumber: createdAt, versionName: id, versionType: 'custom', filePath: `C:/project/${id}.jpg`, fileSize: 1, note: '', status: 'ready', isCurrent: false, isFinal: false, fileMissing, contentChanged: false, createdAt, updatedAt: createdAt });
  const entries = [
    { branchIndex: 2, progressId: 'v2', nodeRole: 'progress', relationKind: 'main', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('third', 30, true) },
    { branchIndex: 0, progressId: 'raw', nodeRole: 'original', relationKind: 'main', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('first', 10) },
    { branchIndex: 1, progressId: 'selection', nodeRole: 'progress', relationKind: 'auxiliary', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('aux', 15) },
    { branchIndex: 1, progressId: 'v1', nodeRole: 'progress', relationKind: 'main', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('second', 20) },
    { branchIndex: 1, progressId: 'broll', nodeRole: 'broll', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('behind-scenes', 18) },
    { branchIndex: 0, progressId: 'raw', nodeRole: 'original', relationKind: 'main', photoId: 'photo-b', originalName: 'other.jpg', version: { ...version('other', 5), photoId: 'photo-b' } },
  ];
  assert.deepStrictEqual(model.mainBranchVersionsForPhoto(entries, 'photo-a').map(item => item.id), ['first', 'second', 'third'], 'main branch order follows branchIndex and excludes auxiliary');
  assert.strictEqual(model.mainBranchVersionsForPhoto(entries, 'photo-a').at(-1).fileMissing, true, 'missing versions remain in the branch');
  assert.strictEqual(model.mainBranchVersionsForPhoto(entries, 'photo-a').length, 3, 'photo identity, not renamed file names, controls association');
  assert(!model.mainBranchVersionsForPhoto(entries, 'photo-a').some(item => item.id === 'behind-scenes'), 'broll must never enter the original/progress main branch');

  const summaries = model.mainBranchPhotoSummaries(entries);
  assert.deepStrictEqual(new Set(summaries.map(item => item.photoId)), new Set(['photo-a', 'photo-b']));
  assert.strictEqual(summaries.find(item => item.photoId === 'photo-a').versionCount, 3);
  assert.strictEqual(summaries[0].photoId, 'photo-a', 'photos with more versions must be sorted before single-version photos');

  const many = Array.from({ length: 1007 }, (_, index) => ({ photoId: `photo-${index}`, originalName: `${index}.jpg`, firstBranchIndex: 0, versionCount: 1, missing: false }));
  const firstPage = model.paginateMainBranchPhotos(many, 0, 48);
  const lastPage = model.paginateMainBranchPhotos(many, 999, 48);
  assert.strictEqual(firstPage.items.length, 48);
  assert.strictEqual(firstPage.pageCount, 21);
  assert.strictEqual(lastPage.currentPage, 20);
  assert.strictEqual(lastPage.items.length, 47);
  console.log('version manager main-branch scope and pagination tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
