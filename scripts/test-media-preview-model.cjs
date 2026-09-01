const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const { formatMediaDuration } = await import(pathToFileURL(path.resolve(
    __dirname,
    '..',
    'src',
    'features',
    'workspace',
    'media-preview-model.ts',
  )).href);

  assert.equal(formatMediaDuration(), '—');
  assert.equal(formatMediaDuration(0), '—');
  assert.equal(formatMediaDuration(Number.NaN), '—');
  assert.equal(formatMediaDuration(5.49), '0:05');
  assert.equal(formatMediaDuration(65.5), '1:06');
  assert.equal(formatMediaDuration(3661), '1:01:01');

  console.log('Media preview model tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
