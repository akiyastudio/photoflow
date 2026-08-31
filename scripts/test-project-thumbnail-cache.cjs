const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'useProjectThumbnail.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const electronAPI = { onThumbnailStateChanged: () => () => undefined };
const moduleUnderTest = { exports: {} };
const localRequire = request => request === '../../platform/project-workspace-client'
  ? { projectWorkspaceClient: electronAPI }
  : require(request);
new Function('module', 'exports', 'require', compiled)(moduleUnderTest, moduleUnderTest.exports, localRequire);

(() => {
  const thumbnail = moduleUnderTest.exports;
  assert.strictEqual(thumbnail.normalizeThumbnailPathIdentity('C:\\Photos\\A.JPG\\'), 'c:/photos/a.jpg');
  assert.strictEqual(thumbnail.normalizeThumbnailPathIdentity('c:/photos//a.jpg'), 'c:/photos/a.jpg');
  assert.strictEqual(thumbnail.normalizeThumbnailPathIdentity('\\\\Server\\Share\\A.JPG\\'), '//server/share/a.jpg');
  assert.strictEqual(thumbnail.normalizeThumbnailPathIdentity('/Volumes/Case/A.JPG/'), '/Volumes/Case/A.JPG', 'POSIX path identity remains case-sensitive');

  const key = thumbnail.mediaThumbnailPreviewKey('C:\\Photos\\A.JPG\\', 10, 320);
  thumbnail.rememberMediaThumbnailPreview(key, 'preview');
  assert.strictEqual(thumbnail.getMediaThumbnailPreview(thumbnail.mediaThumbnailPreviewKey('c:/photos/a.jpg', 10, 320)), 'preview');
  assert.strictEqual(thumbnail.findCachedMediaThumbnailPreview('C:/PHOTOS/A.JPG/', 10)?.url, 'preview');
  thumbnail.forgetMediaThumbnailPreviews('c:\\photos\\a.jpg');
  assert.strictEqual(thumbnail.getMediaThumbnailPreview(key), undefined, 'forget uses the same normalized identity as lookup and insertion');
  console.log('Project thumbnail cache tests passed.');
})();
