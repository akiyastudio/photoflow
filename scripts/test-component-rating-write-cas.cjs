const assert = require('assert').strict; const fs = require('fs'); const os = require('os'); const path = require('path');
const { createMediaRatingService } = require('../electron/services/media-rating-service.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-rating-cas-')); const filePath = path.join(root, 'photo.jpg');
const makeService = ({ refresh = async () => ({ success: true }) } = {}) => { let writes = 0; return { get writes() { return writes; }, service: createMediaRatingService({ fs, path, imageExtensions: new Set(['.jpg']), rawExtensions: new Set(), releaseWorkspaceWatchPath: () => undefined, suppressWorkspaceWatchPath: () => undefined, projectVirtualPaths: null, writeLog: () => undefined, pendingRatingsPath: '', versionService: { refreshMetadataFingerprint: refresh }, exiftool: { readRaw: async () => ({}), write: async target => { writes += 1; await fs.promises.appendFile(target, `-${writes}`); } } }) }; };
const waitFor = async predicate => { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('rating test timed out'); };
(async () => { try {
  fs.writeFileSync(filePath, 'photo'); let fixture = makeService(); let expected = fs.statSync(filePath).mtimeMs;
  const [first, second] = await Promise.allSettled([fixture.service.writeChecked(root, filePath, 4, expected), fixture.service.writeChecked(root, filePath, 2, expected)]); assert.equal(first.status, 'fulfilled'); assert.equal(second.status, 'rejected'); assert.equal(second.reason.code, 'MEDIA_RATING_REVISION_CONFLICT'); assert.equal(fixture.writes, 1, 'checked writes serialize and recheck CAS');

  fs.writeFileSync(filePath, 'legacy-first'); fixture = makeService(); expected = fs.statSync(filePath).mtimeMs; await fixture.service.write(root, filePath, 3); const checkedAfterLegacy = fixture.service.writeChecked(root, filePath, 5, expected); await assert.rejects(checkedAfterLegacy, error => error.code === 'MEDIA_RATING_REVISION_CONFLICT'); assert.equal(fixture.writes, 1, 'legacy outbox write and checked write share the same per-file queue');

  fs.writeFileSync(filePath, 'refresh-failure'); fixture = makeService({ refresh: async () => { throw new Error('injected refresh failure'); } }); expected = fs.statSync(filePath).mtimeMs; const refreshFailure = await fixture.service.writeChecked(root, filePath, 2, expected); assert.equal(refreshFailure.rating, 2); assert(refreshFailure.revision > expected); assert.equal(fixture.writes, 1, 'successful ExifTool side effect remains a successful API result when fingerprint refresh fails');
  await waitFor(() => fixture.writes === 1);
  console.log('Component rating serialized CAS tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); } })().catch(error => { console.error(error); process.exitCode = 1; });
