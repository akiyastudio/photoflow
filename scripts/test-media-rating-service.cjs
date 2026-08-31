const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMediaRatingService } = require('../electron/services/media-rating-service.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-media-rating-'));

const trackTargetHandles = targetPath => {
  const resolvedTarget = path.resolve(targetPath);
  const trackedFs = Object.create(fs);
  const trackedPromises = Object.create(fs.promises);
  let activeHandles = 0;
  trackedPromises.open = async (filePath, ...args) => {
    const handle = await fs.promises.open(filePath, ...args);
    if (path.resolve(filePath) !== resolvedTarget) return handle;
    activeHandles += 1;
    let closed = false;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'close') return async () => {
          try { return await target.close(); }
          finally { if (!closed) { closed = true; activeHandles -= 1; } }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  Object.defineProperty(trackedFs, 'promises', { value: trackedPromises });
  return { fs: trackedFs, activeHandles: () => activeHandles };
};

const run = async () => {
  try {
    const filePath = path.join(temporaryRoot, 'photo.jpg');
    const outboxPath = path.join(temporaryRoot, 'pending-ratings.json');
    fs.writeFileSync(filePath, 'photo');
    const tracked = trackTargetHandles(filePath);
    let finishWrite;
    const writeFinished = new Promise(resolve => { finishWrite = resolve; });
    let metadataWrites = 0;
    let fingerprintRefreshes = 0;
    const physicalRatings = new Map();
    const writeCalls = [];
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
        readRaw: async target => {
          if (path.resolve(target) === path.resolve(filePath)) assert.strictEqual(tracked.activeHandles(), 0, 'readRaw must not overlap a target FileHandle');
          return { 'XMP:Rating': physicalRatings.get(path.resolve(target)) ?? 5 };
        },
        write: async (target, tags, options) => {
          assert.strictEqual(tracked.activeHandles(), 0, 'exiftool.write must not overlap a target FileHandle');
          metadataWrites += 1;
          writeCalls.push(options.writeArgs);
          if (metadataWrites === 1) await writeFinished;
          physicalRatings.set(path.resolve(target), tags['XMP:Rating']);
          await fs.promises.appendFile(target, `-${tags['XMP:Rating']}`);
        },
      },
      fs: tracked.fs,
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
    assert.deepStrictEqual(writeCalls[0], ['-overwrite_original', '-P']);

    const expectedRevision = fs.statSync(filePath).mtimeMs;
    const checked = await service.writeChecked(temporaryRoot, filePath, 4, expectedRevision);
    assert.strictEqual(checked.rating, 4);
    assert(checked.revision > expectedRevision);
    for (let index = 0; index < 100 && JSON.parse(fs.readFileSync(outboxPath, 'utf8')).items.length; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(outboxPath, 'utf8')).items.length, 0, 'a checked metadata write must clear the durable outbox');
    assert.strictEqual(fingerprintRefreshes, 2);
    assert.deepStrictEqual(writeCalls[1], ['-overwrite_original_in_place']);
    assert.strictEqual(tracked.activeHandles(), 0);

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
