const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { mergeProjectFileQueryEntries, projectFileQueryRequestIdentity } = await import(pathToFileURL(path.resolve(__dirname, '../src/features/workspace/project-file-query-model.ts')).href);
  const entry = (pathValue) => ({ path: pathValue, name: path.basename(pathValue), relativePath: pathValue });

  assert.deepStrictEqual(
    mergeProjectFileQueryEntries([entry('A.jpg')], [entry('a.JPG'), entry('B.jpg')], false).map(item => item.path),
    ['A.jpg', 'B.jpg'],
    'continuing a cursor keeps prior ordering and removes case-insensitive duplicates',
  );
  assert.deepStrictEqual(
    mergeProjectFileQueryEntries([entry('old.jpg')], [entry('fresh.jpg')], true).map(item => item.path),
    ['fresh.jpg'],
    'an expired cursor replacement discards the obsolete session snapshot',
  );
  assert.notStrictEqual(
    projectFileQueryRequestIdentity(['active', 'recent', '项目', '']),
    projectFileQueryRequestIdentity(['active', 'recent', '项目', '子目录']),
    'directory scope participates in request identity so late results cannot cross folders',
  );
  console.log('project file query model tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
