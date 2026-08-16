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
    const service = createMediaRatingService({
      exiftool: {
        readRaw: async () => ({ 'XMP:Rating': 0 }),
        write: async () => { metadataWrites += 1; await writeFinished; },
      },
      fs,
      path,
      imageExtensions: new Set(['.jpg']),
      rawExtensions: new Set(),
      releaseWorkspaceWatchPath: () => undefined,
      suppressWorkspaceWatchPath: () => undefined,
      versionService: { refreshMetadataFingerprint: async () => { fingerprintRefreshes += 1; } },
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
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write('media rating outbox tests passed\n');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
