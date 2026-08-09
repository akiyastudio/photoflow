const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const labels = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'metadata', 'metadata-labels.ts')).href);
  assert.strictEqual(labels.metadataFieldLabel('FileName'), '文件名');
  assert.strictEqual(labels.metadataFieldLabel('DateTimeOriginal'), '原始拍摄时间');
  assert.strictEqual(labels.metadataFieldLabel('UnknownEnglishField'), 'UnknownEnglishField');
  assert.strictEqual(labels.metadataFieldLabel('撮影モード'), '撮影モード');
  assert.strictEqual(labels.metadataFieldLabel('XMP-custom:ClientProperty'), 'XMP-custom:ClientProperty');
  assert.strictEqual(labels.metadataFieldLabel(''), '未命名属性');
  assert.strictEqual(labels.metadataFieldLabel('   '), '未命名属性');
  assert.strictEqual(labels.metadataGroupLabel('ExifIFD'), '拍摄信息');
  assert.strictEqual(labels.metadataGroupLabel('CustomGroup'), 'CustomGroup');
  assert.strictEqual(labels.metadataGroupLabel('カスタム'), 'カスタム');
  assert.strictEqual(labels.metadataGroupLabel(''), '未命名属性');
  console.log('shared metadata label tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

