const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMediaRatingService } = require('../electron/services/media-rating-service.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-media-rating-'));

const run = async () => {
  try {
    const filePath = path.join(temporaryRoot, 'photo.jpg');
    const outboxPath = path.join(temporaryRoot, 'pending-ratings.json');
    fs.writeFileSync(filePath, 'photo');
    let finishWrite;
    const writeFinished = new Promise(resolve => { finishWrite = resolve; });
    let metadataWrites = 0;
    let fingerprintRefreshes = 0;
    const favoriteExport = path.join(temporaryRoot, '任意自由名称');
    const legacyFavoriteExport = path.join(temporaryRoot, '图片后期_N_喜爱');
    const metadataNamedLikeLegacy = path.join(temporaryRoot, '图片后期_自定义_喜爱');
    const ordinaryProgress = path.join(temporaryRoot, '另一个目录');
    fs.mkdirSync(favoriteExport);
    fs.mkdirSync(legacyFavoriteExport);
    fs.mkdirSync(metadataNamedLikeLegacy);
    fs.mkdirSync(ordinaryProgress);
    fs.writeFileSync(path.join(favoriteExport, 'excluded.jpg'), 'excluded');
    fs.writeFileSync(path.join(legacyFavoriteExport, 'legacy-excluded.jpg'), 'legacy-excluded');
    fs.writeFileSync(path.join(metadataNamedLikeLegacy, 'metadata-included.jpg'), 'metadata-included');
    fs.writeFileSync(path.join(ordinaryProgress, 'included.jpg'), 'included');
    const service = createMediaRatingService({
      exiftool: {
        readRaw: async () => ({ 'XMP:Rating': 5 }),
        write: async () => { metadataWrites += 1; await writeFinished; },
      },
      fs,
      path,
      imageExtensions: new Set(['.jpg']),
      rawExtensions: new Set(),
      releaseWorkspaceWatchPath: () => undefined,
      suppressWorkspaceWatchPath: () => undefined,
      versionService: {
        refreshMetadataFingerprint: async () => { fingerprintRefreshes += 1; },
        listProgress: async () => ({ success: true, progressFolders: [
          { folderPath: favoriteExport, sourceMetadata: { category: 'favorite-export' } },
          { folderPath: legacyFavoriteExport, sourceMetadata: null },
          { folderPath: metadataNamedLikeLegacy, sourceMetadata: { category: 'progress' } },
          { folderPath: ordinaryProgress, sourceMetadata: null },
        ] }),
      },
      projectVirtualPaths: { listManagedExternalLinks: () => [] },
      writeLog: () => undefined,
      pendingRatingsPath: outboxPath,
    });

    const rating = await service.write(temporaryRoot, filePath, 5);
    assert.strictEqual(rating, 5);
    assert.strictEqual(metadataWrites, 1, 'metadata persistence should start in the background');
    assert.strictEqual(await service.read(filePath), 5, 'the durable outbox value should be immediately readable');
    assert.strictEqual(JSON.parse(fs.readFileSync(outboxPath, 'utf8')).items.length, 1, 'the requested rating must be durable before the interactive call returns');

    finishWrite();
    for (let index = 0; index < 100 && JSON.parse(fs.readFileSync(outboxPath, 'utf8')).items.length; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(outboxPath, 'utf8')).items.length, 0, 'a successful metadata write must clear the durable outbox');
    assert.strictEqual(fingerprintRefreshes, 1);
    const rated = await service.listProject(temporaryRoot, { workspaceRoot: temporaryRoot, projectName: 'Project' });
    assert(rated.some(entry => entry.name === 'included.jpg'));
    assert(!rated.some(entry => entry.name === 'excluded.jpg'), 'favorite exports must be excluded by persisted node purpose, not a folder-name regex');
    assert(!rated.some(entry => entry.name === 'legacy-excluded.jpg'), 'legacy databases without source metadata must retain favorite-export compatibility');
    assert(rated.some(entry => entry.name === 'metadata-included.jpg'), 'explicit modern metadata must override the legacy folder-name fallback');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write('media rating outbox tests passed\n');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
