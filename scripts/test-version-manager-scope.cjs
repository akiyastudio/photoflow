const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
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
