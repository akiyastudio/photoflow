const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'metadata', 'metadata-pane-model.ts')).href);
  const selectionModel = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'multi-selection-metadata-model.ts')).href);
  const fields = [
    { group: 'EXIF', name: 'Rating', value: '1' },
    { group: '文件:基础', name: 'Name', value: 'a.jpg' },
    { group: 'EXIF', name: 'ISO', value: '100' },
  ];

  assert.strictEqual(model.EMPTY_MEDIA_METADATA_FIELDS, model.EMPTY_MEDIA_METADATA_FIELDS, 'empty fallback must be a module singleton');
  assert(Object.isFrozen(model.EMPTY_MEDIA_METADATA_FIELDS), 'empty fallback must not be mutable');
  assert.strictEqual(model.previewMetadataFieldsForEntry(fields, 'C:/a.jpg', 'C:/a.jpg'), fields, 'matching paths must preserve the source array');
  assert.strictEqual(model.previewMetadataFieldsForEntry(fields, 'C:/a.jpg', 'C:/b.jpg'), model.EMPTY_MEDIA_METADATA_FIELDS, 'mismatched paths must use the stable fallback');
  assert.strictEqual(model.previewMetadataFieldsForEntry(fields, '', undefined), model.EMPTY_MEDIA_METADATA_FIELDS);

  const changedValues = fields.map(field => ({ ...field, value: `${field.value}-changed` }));
  const key = model.metadataGroupDependencyKey(fields);
  assert.strictEqual(model.metadataGroupDependencyKey(changedValues), key, 'field values must not affect the dependency key');
  assert.strictEqual(JSON.parse(key).filter(group => group === 'EXIF').length, 1, 'duplicate groups must be removed');
  assert.notStrictEqual(model.metadataGroupDependencyKey([...fields, { group: '新增', name: 'x', value: 'y' }]), key);
  assert.notStrictEqual(
    model.metadataGroupDependencyKey([{ group: '甲:乙', name: 'x', value: '1' }, { group: '丙', name: 'y', value: '2' }]),
    model.metadataGroupDependencyKey([{ group: '甲', name: 'x', value: '1' }, { group: '乙:丙', name: 'y', value: '2' }]),
    'JSON encoding must avoid delimiter collisions',
  );

  let expanded = model.reconcileExpandedMetadataGroups(new Set(), 'C:/a.jpg', key);
  assert.deepStrictEqual([...expanded].sort(), ['Application', 'EXIF', '文件:基础'].sort());
  assert.strictEqual(model.reconcileExpandedMetadataGroups(expanded, 'C:/a.jpg', key), expanded, 'an unchanged target must preserve Set identity');
  const collapsed = new Set(expanded);
  collapsed.delete('EXIF');
  assert.strictEqual(model.metadataGroupDependencyKey(changedValues), key, 'value-only refreshes must not retrigger the coordinating effect');
  const nextFile = model.reconcileExpandedMetadataGroups(collapsed, 'C:/b.jpg', key);
  assert.notStrictEqual(nextFile, collapsed, 'switching files must restore default expansion');
  assert(nextFile.has('EXIF'));
  const empty = model.reconcileExpandedMetadataGroups(nextFile, undefined, model.metadataGroupDependencyKey([]));
  assert.strictEqual(empty.size, 0, 'no selected file must have no expanded groups');
  const fileWithoutMetadata = model.reconcileExpandedMetadataGroups(empty, 'C:/empty.jpg', model.metadataGroupDependencyKey([]));
  assert.deepStrictEqual([...fileWithoutMetadata], ['Application']);

  const entries = [
    { name: 'one.mp4', path: 'C:/project/mov/one.mp4', relativePath: 'mov/one.mp4', kind: 'video', extension: '.mp4', size: 1024, createdAt: 1000, updatedAt: 3000 },
    { name: 'two.mp4', path: 'C:/project/mov/two.mp4', relativePath: 'mov/two.mp4', kind: 'video', extension: '.mp4', size: 2048, createdAt: 2000, updatedAt: 4000 },
  ];
  const mediaSummary = selectionModel.summarizeMultiSelection(entries);
  assert.strictEqual(mediaSummary.selectedCount, 2);
  assert.strictEqual(mediaSummary.selectedFileCount, 2);
  assert.strictEqual(mediaSummary.totalSize, 3072, 'known file sizes must be added together');
  assert.strictEqual(mediaSummary.sizeComplete, true);
  assert.strictEqual(mediaSummary.typeSummary, '2 个视频');
  assert.strictEqual(mediaSummary.formatSummary, 'MP4');
  assert.strictEqual(mediaSummary.commonParentPath, 'mov');
  assert.deepStrictEqual([mediaSummary.earliestCreatedAt, mediaSummary.latestCreatedAt], [1000, 2000]);

  const folder = { name: 'stills', path: 'C:/project/stills', relativePath: 'stills', kind: 'folder', extension: '', size: 0, createdAt: 500, updatedAt: 5000 };
  const pendingFolderSummary = selectionModel.summarizeMultiSelection([...entries, folder]);
  assert.strictEqual(pendingFolderSummary.sizeComplete, false, 'folder totals must remain pending until recursive details arrive');
  const completeFolderSummary = selectionModel.summarizeMultiSelection([...entries, folder], {
    [folder.path]: { size: 4096, createdAt: 500, updatedAt: 5000, fileCount: 3, folderCount: 1 },
  });
  assert.strictEqual(completeFolderSummary.totalSize, 7168);
  assert.strictEqual(completeFolderSummary.containedFileCount, 5);
  assert.strictEqual(completeFolderSummary.containedFolderCount, 1);
  assert.strictEqual(completeFolderSummary.typeSummary, '1 个文件夹，2 个视频');
  assert.strictEqual(completeFolderSummary.commonParentPath, '');

  console.log('metadata pane model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
