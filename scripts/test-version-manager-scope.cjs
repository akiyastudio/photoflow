const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'VersionManager.tsx'), 'utf8');
  const mediaIpcSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'modules', 'media-ipc.cjs'), 'utf8');
  assert(/kind === 'raw'\s*\? window\.electronAPI\.getMediaOriginal/.test(source), 'RAW version previews must obtain the rendered source and orientation from the same IPC result');
  assert(source.includes('aria-expanded={open}') && source.includes('openMetadataGroups'), 'version metadata groups must use explicit controlled buttons');
  assert(source.includes('const branchPhotoRequestRef = useRef(0)') && !source.includes('disabled={branchPhotoLoading} aria-pressed={activePhotoId'), 'branch photos must remain clickable while another photo request is pending');
  assert(source.includes('const loadRequestRef = useRef(0)') && source.includes('requestId !== loadRequestRef.current'), 'stale version-load responses must not overwrite a newer entry');
  assert(source.includes('const pageGenerationRef = useRef(0)') && (source.match(/pageGenerationIsCurrent\(pageGeneration\)/g) || []).length >= 12, 'every version mutation stage must ignore responses from an older entry generation');
  assert(source.includes('const selectBranchPhoto = async') && source.includes('const pageGeneration = ++pageGenerationRef.current') && source.includes('selectBranchPhoto(photo.photoId)'), 'switching the active main-branch photo must start a new page generation');
  for (const marker of ['updateMediaVersion(workspacePath, request)', 'getMediaVersionDeleteScope(workspacePath, version.id)', 'deleteProjectMissingMediaVersion(workspacePath, version.id)', 'deleteMediaVersion(workspacePath', 'relocateMediaVersion(workspacePath']) {
    const index = source.indexOf(marker);
    assert(index >= 0 && source.slice(index, index + 500).includes('pageGenerationIsCurrent(pageGeneration)'), `${marker} must check page generation after awaiting IPC`);
  }
  assert(source.includes("setBundle({ ...result, versions: [] })") && source.includes("setSelectedId('')") && source.includes("setCompareIds([])"), 'a failed version load must clear the prior entry instead of leaving stale media visible');
  assert(source.includes('className="absolute inset-0 z-0 cursor-pointer rounded-xl'), 'each version card must expose a real full-card preview button');
  assert(mediaIpcSource.includes('const orientation = await rawOrientationCorrection(sourcePath, previewPath, stat);') && !mediaIpcSource.includes('orientationTimer = setTimeout'), 'slow RAW orientation reads must not silently fall back to an incorrect identity transform');
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'versioning', 'version-manager-model.ts')).href);
  const version = (id, createdAt, fileMissing = false) => ({ id, photoId: 'photo-a', versionNumber: createdAt, versionName: id, versionType: 'custom', filePath: `C:/project/${id}.jpg`, fileSize: 1, note: '', status: 'ready', isCurrent: false, isFinal: false, fileMissing, contentChanged: false, createdAt, updatedAt: createdAt });
  const entries = [
    { branchIndex: 2, progressId: 'v2', nodeRole: 'progress', relationKind: 'main', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('third', 30, true) },
    { branchIndex: 0, progressId: 'raw', nodeRole: 'original', relationKind: 'main', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('first', 10) },
    { branchIndex: 1, progressId: 'selection', nodeRole: 'progress', relationKind: 'auxiliary', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('aux', 15) },
    { branchIndex: 1, progressId: 'v1', nodeRole: 'progress', relationKind: 'main', photoId: 'photo-a', originalName: 'renamed-original.jpg', version: version('second', 20) },
    { branchIndex: 0, progressId: 'raw', nodeRole: 'original', relationKind: 'main', photoId: 'photo-b', originalName: 'other.jpg', version: { ...version('other', 5), photoId: 'photo-b' } },
  ];
  assert.deepStrictEqual(model.mainBranchVersionsForPhoto(entries, 'photo-a').map(item => item.id), ['first', 'second', 'third'], 'main branch order follows branchIndex and excludes auxiliary');
  assert.strictEqual(model.mainBranchVersionsForPhoto(entries, 'photo-a').at(-1).fileMissing, true, 'missing versions remain in the branch');
  assert.strictEqual(model.mainBranchVersionsForPhoto(entries, 'photo-a').length, 3, 'photo identity, not renamed file names, controls association');

  const summaries = model.mainBranchPhotoSummaries(entries);
  assert.deepStrictEqual(new Set(summaries.map(item => item.photoId)), new Set(['photo-a', 'photo-b']));
  assert.strictEqual(summaries.find(item => item.photoId === 'photo-a').versionCount, 3);

  const many = Array.from({ length: 1007 }, (_, index) => ({ photoId: `photo-${index}`, originalName: `${index}.jpg`, firstBranchIndex: 0, versionCount: 1, missing: false }));
  const firstPage = model.paginateMainBranchPhotos(many, 0, 48);
  const lastPage = model.paginateMainBranchPhotos(many, 999, 48);
  assert.strictEqual(firstPage.items.length, 48);
  assert.strictEqual(firstPage.pageCount, 21);
  assert.strictEqual(lastPage.currentPage, 20);
  assert.strictEqual(lastPage.items.length, 47);
  console.log('version manager main-branch scope and pagination tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
