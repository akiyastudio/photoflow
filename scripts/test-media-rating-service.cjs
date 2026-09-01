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

const waitFor = async predicate => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for media rating state');
};

const ratingService = ({ root, outbox, readRaw, write, refresh = async () => undefined, links = () => [], fileSystem = fs, retryDelayMs = 60000 }) => createMediaRatingService({
  exiftool: { readRaw, write }, fs: fileSystem, path,
  imageExtensions: new Set(['.jpg']), rawExtensions: new Set(),
  releaseWorkspaceWatchPath: () => undefined, suppressWorkspaceWatchPath: () => undefined,
  versionService: { refreshMetadataFingerprint: refresh, listProgress: async () => ({ progressFolders: [] }) },
  projectVirtualPaths: { listManagedExternalLinks: links }, writeLog: () => undefined,
  pendingRatingsPath: outbox, retryDelayMs, checkedRetryDelayMs: 5, checkedRetryDeadlineMs: 1000,
});

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
    const writeTargets = [];
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
          assert.notStrictEqual(path.resolve(target), path.resolve(filePath), 'ExifTool must never receive the public media path');
          assert(path.basename(target).startsWith('.photoflow-rating-') && path.extname(target) === '.jpg', 'the verified hardlink alias must remain internal and retain the media extension');
          metadataWrites += 1;
          writeCalls.push(options.writeArgs);
          writeTargets.push(path.resolve(target));
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
    assert.strictEqual(fs.readdirSync(temporaryRoot).filter(name => name.startsWith('.photoflow-rating-')).length, 1, 'an active write owns one verified hardlink alias');
    const duringWriteEntries = await service.listProject(temporaryRoot, { workspaceRoot: temporaryRoot, projectName: 'Project' });
    const duringWriteSummary = await service.summarizeProject(temporaryRoot, { workspaceRoot: temporaryRoot, projectName: 'Project' });
    assert(!duringWriteEntries.some(entry => entry.name.startsWith('.photoflow-')), 'internal rating aliases must never appear in rating browse results');
    assert.strictEqual(duringWriteSummary.count, duringWriteEntries.length, 'internal rating aliases must not inflate rating summaries');

    finishWrite();
    for (let index = 0; index < 100 && JSON.parse(fs.readFileSync(outboxPath, 'utf8')).items.length; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(outboxPath, 'utf8')).items.length, 0, 'a successful metadata write must clear the durable outbox');
    assert.strictEqual(fingerprintRefreshes, 1);
    assert.deepStrictEqual(writeCalls[0], ['-overwrite_original_in_place', '-P']);
    assert.strictEqual(fs.readdirSync(temporaryRoot).filter(name => name.startsWith('.photoflow-rating-')).length, 0, 'successful ordinary writes must remove their alias');

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
    assert(writeTargets.every(target => path.basename(target).startsWith('.photoflow-rating-')));
    assert.strictEqual(fs.readdirSync(temporaryRoot).filter(name => name.startsWith('.photoflow-rating-')).length, 0, 'successful checked writes must remove their alias');
    assert.strictEqual(tracked.activeHandles(), 0);

    const rated = await service.listProject(temporaryRoot, { workspaceRoot: temporaryRoot, projectName: 'Project' });
    assert(rated.some(entry => entry.name === 'included.jpg'));
    assert(!rated.some(entry => entry.name === 'excluded.jpg'), 'favorite exports must be excluded by persisted node purpose, not a folder-name regex');
    assert(!rated.some(entry => entry.name === 'legacy-excluded.jpg'), 'legacy databases without source metadata must retain favorite-export compatibility');
    assert(rated.some(entry => entry.name === 'metadata-included.jpg'), 'explicit modern metadata must override the legacy folder-name fallback');

    const parseRating = target => {
      const matches = fs.readFileSync(target, 'utf8').match(/rating=(\d)/gu);
      return { 'XMP:Rating': matches ? Number(matches.at(-1).slice(-1)) : 0 };
    };

    const raceRoot = path.join(temporaryRoot, 'replacement-race'); fs.mkdirSync(raceRoot);
    const raceFile = path.join(raceRoot, 'race.jpg'); const displaced = path.join(raceRoot, 'displaced.jpg'); const raceOutbox = path.join(raceRoot, 'outbox.json');
    fs.writeFileSync(raceFile, 'original');
    let releaseRace; let markRaceStarted;
    const raceReleased = new Promise(resolve => { releaseRace = resolve; });
    const raceStarted = new Promise(resolve => { markRaceStarted = resolve; });
    const raceService = ratingService({ root: raceRoot, outbox: raceOutbox, readRaw: async target => parseRating(target), write: async target => { markRaceStarted(); await raceReleased; await fs.promises.appendFile(target, '|rating=3'); } });
    const racedWrite = raceService.writeChecked(raceRoot, raceFile, 3, fs.statSync(raceFile).mtimeMs);
    await raceStarted;
    fs.renameSync(raceFile, displaced); fs.writeFileSync(raceFile, 'replacement'); releaseRace();
    await assert.rejects(racedWrite, error => error?.code === 'MEDIA_RATING_IDENTITY_CHANGED');
    assert.strictEqual(fs.readFileSync(raceFile, 'utf8'), 'replacement', 'a path replacement during ExifTool must never be modified');
    assert(JSON.parse(fs.readFileSync(raceOutbox, 'utf8')).items.some(item => item.stage === 'failed' && item.bindingNonce), 'a failed receipt must retain the verified rescue link when the public path changed');

    const recoveryRoot = path.join(temporaryRoot, 'crash-recovery'); fs.mkdirSync(recoveryRoot);
    const recoveryFile = path.join(recoveryRoot, 'recover.jpg'); const recoveryOutbox = path.join(recoveryRoot, 'outbox.json'); fs.writeFileSync(recoveryFile, 'rating=0');
    let physicalWrites = 0; let recoveredFingerprints = 0;
    const interrupted = ratingService({ root: recoveryRoot, outbox: recoveryOutbox, readRaw: async target => parseRating(target), write: async target => { physicalWrites += 1; await fs.promises.appendFile(target, '|rating=4'); throw new Error('simulated crash after physical write'); } });
    await interrupted.write(recoveryRoot, recoveryFile, 4);
    await waitFor(() => { const pending = JSON.parse(fs.readFileSync(recoveryOutbox, 'utf8')).items[0]; return pending?.physicalStarted === true && pending.failureCount >= 1 && parseRating(recoveryFile)['XMP:Rating'] === 4; });
    ratingService({ root: recoveryRoot, outbox: recoveryOutbox, readRaw: async target => parseRating(target), write: async () => { physicalWrites += 1; throw new Error('recovery must not rewrite metadata'); }, refresh: async () => { recoveredFingerprints += 1; } });
    await waitFor(() => JSON.parse(fs.readFileSync(recoveryOutbox, 'utf8')).items.length === 0);
    assert.strictEqual(physicalWrites, 1, 'a completed physical write must recover directly to fingerprint without a second ExifTool call');
    assert.strictEqual(recoveredFingerprints, 1);
    assert.strictEqual(fs.readdirSync(recoveryRoot).filter(name => name.startsWith('.photoflow-rating-')).length, 0, 'recovered writes must remove the proven extra hardlink');

    const terminalRoot = path.join(temporaryRoot, 'terminal-crash'); fs.mkdirSync(terminalRoot);
    const terminalFile = path.join(terminalRoot, 'terminal.jpg'); const terminalOutbox = path.join(terminalRoot, 'outbox.json'); fs.writeFileSync(terminalFile, 'rating=0');
    const terminalFs = Object.create(fs); let rejectedCleanupSaves = 0; let terminalWrites = 0; let rejectCleanedTerminalSaves = false;
    terminalFs.writeFileSync = (target, data, ...args) => {
      let document;
      try { document = JSON.parse(String(data)); } catch { document = null; }
      if (rejectCleanedTerminalSaves && document?.items?.length === 0) { rejectedCleanupSaves += 1; throw new Error('simulated crash before cleaned terminal receipt'); }
      return fs.writeFileSync(target, data, ...args);
    };
    const terminalService = ratingService({ root: terminalRoot, outbox: terminalOutbox, fileSystem: terminalFs, readRaw: async target => parseRating(target), write: async target => { terminalWrites += 1; await fs.promises.appendFile(target, '|rating=3'); rejectCleanedTerminalSaves = true; const error = new Error('permanent failure after physical write'); error.code = 'MEDIA_RATING_IDENTITY_CHANGED'; throw error; } });
    await terminalService.write(terminalRoot, terminalFile, 3);
    await waitFor(() => { const item = JSON.parse(fs.readFileSync(terminalOutbox, 'utf8')).items[0]; return rejectedCleanupSaves > 0 && item?.stage === 'failed' && item.bindingNonce && item.physicalStarted === true; });
    ratingService({ root: terminalRoot, outbox: terminalOutbox, readRaw: async target => parseRating(target), write: async () => { terminalWrites += 1; } });
    await waitFor(() => JSON.parse(fs.readFileSync(terminalOutbox, 'utf8')).items.length === 0);
    assert.strictEqual(terminalWrites, 1, 'a crash between durable failure and binding cleanup must never re-run the physical write');

    const capacityRoot = path.join(temporaryRoot, 'terminal-capacity'); fs.mkdirSync(capacityRoot);
    const capacityFile = path.join(capacityRoot, 'capacity.jpg'); const capacityOutbox = path.join(capacityRoot, 'outbox.json'); fs.writeFileSync(capacityFile, 'rating=0');
    const terminalHistory = Array.from({ length: 10000 }, (_, index) => ({ workspaceRoot: capacityRoot, filePath: capacityFile, token: `failed-${index}`, type: 'ordinary', stage: 'failed', rating: index % 6, sequence: index + 1, updatedAt: Date.now() }));
    fs.writeFileSync(capacityOutbox, JSON.stringify({ version: 1, items: terminalHistory }));
    const capacityService = ratingService({ root: capacityRoot, outbox: capacityOutbox, readRaw: async target => parseRating(target), write: async () => undefined });
    await waitFor(() => JSON.parse(fs.readFileSync(capacityOutbox, 'utf8')).items.length === 0);
    await assert.rejects(capacityService.writeChecked(capacityRoot, capacityFile, 2, fs.statSync(capacityFile).mtimeMs - 1), error => error?.code === 'MEDIA_RATING_REVISION_CONFLICT');
    await waitFor(() => JSON.parse(fs.readFileSync(capacityOutbox, 'utf8')).items.length === 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(capacityOutbox, 'utf8')).items.length, 0, 'more than 10000 historical permanent failures must still leave a restart-readable outbox');
    fs.writeFileSync(capacityOutbox, JSON.stringify({ version: 1, items: [...terminalHistory, { ...terminalHistory[0], token: 'oversized' }] }));
    fs.rmSync(`${capacityOutbox}.backup`, { force: true });
    const oversizedService = ratingService({ root: capacityRoot, outbox: capacityOutbox, readRaw: async target => parseRating(target), write: async () => undefined });
    await assert.rejects(oversizedService.write(capacityRoot, capacityFile, 2), /待处理文件损坏/);
    assert.strictEqual(JSON.parse(fs.readFileSync(capacityOutbox, 'utf8')).items.length, 10001, 'an oversized outbox must remain untouched and fail closed');

    const legacyRoot = path.join(temporaryRoot, 'legacy-outbox'); fs.mkdirSync(legacyRoot);
    const legacyMetadata = path.join(legacyRoot, 'metadata.jpg'); const legacyWriting = path.join(legacyRoot, 'writing.jpg'); const legacyProven = path.join(legacyRoot, 'proven.jpg'); const legacyOutbox = path.join(legacyRoot, 'outbox.json');
    fs.writeFileSync(legacyMetadata, 'rating=1'); fs.writeFileSync(legacyWriting, 'rating=2'); fs.writeFileSync(legacyProven, 'rating=5');
    fs.writeFileSync(legacyOutbox, JSON.stringify({ version: 1, items: [
      { workspaceRoot: legacyRoot, filePath: legacyMetadata, token: 'legacy-metadata', type: 'ordinary', stage: 'metadata', rating: 1, sequence: 1, updatedAt: Date.now() },
      { workspaceRoot: legacyRoot, filePath: legacyWriting, token: 'legacy-writing', type: 'ordinary', stage: 'writing', rating: 2, sequence: 2, updatedAt: Date.now() },
      { workspaceRoot: legacyRoot, filePath: legacyProven, token: 'legacy-proven', type: 'ordinary', stage: 'writing', rating: 5, revision: fs.statSync(legacyProven).mtimeMs, sequence: 3, updatedAt: Date.now() },
    ] }));
    let legacyWrites = 0; let legacyFingerprints = 0;
    ratingService({ root: legacyRoot, outbox: legacyOutbox, readRaw: async target => parseRating(target), write: async () => { legacyWrites += 1; }, refresh: async () => { legacyFingerprints += 1; } });
    await waitFor(() => JSON.parse(fs.readFileSync(legacyOutbox, 'utf8')).items.length === 0);
    assert.strictEqual(legacyWrites, 0, 'unproven legacy metadata/writing intents must fail closed');
    assert.strictEqual(legacyFingerprints, 1, 'a legacy writing intent proven by rating and revision may finish fingerprinting');

    const provenanceRoot = path.join(temporaryRoot, 'provenance'); const externalRoot = path.join(temporaryRoot, 'external'); fs.mkdirSync(provenanceRoot); fs.mkdirSync(externalRoot);
    const externalFile = path.join(externalRoot, 'external.jpg'); fs.writeFileSync(externalFile, 'rating=0');
    const deniedService = ratingService({ root: provenanceRoot, outbox: path.join(provenanceRoot, 'denied.json'), readRaw: async target => parseRating(target), write: async () => undefined });
    await assert.rejects(deniedService.write(provenanceRoot, externalFile, 2), error => error?.code === 'MEDIA_RATING_WORKSPACE_PROVENANCE_REQUIRED');
    const shortcutPath = path.join(provenanceRoot, 'project', 'external.lnk'); fs.mkdirSync(path.dirname(shortcutPath));
    const linkedAlias = path.join(externalRoot, `.photoflow-rating-${'a'.repeat(32)}.jpg`); fs.writeFileSync(linkedAlias, 'rating=5');
    const aliasLink = [{ shortcutPath, externalTargetRoot: linkedAlias, externalTargetKind: 'file', offline: false }];
    const linkedAliasService = ratingService({ root: provenanceRoot, outbox: path.join(provenanceRoot, 'linked-alias.json'), readRaw: async target => parseRating(target), write: async () => undefined, links: () => aliasLink });
    assert.deepStrictEqual(await linkedAliasService.listProject(provenanceRoot), [], 'a managed file link must not expose an internal rating alias');
    assert.strictEqual((await linkedAliasService.summarizeProject(provenanceRoot)).count, 0, 'a managed file link must not count an internal rating alias');
    fs.rmSync(linkedAlias);
    const managedService = ratingService({ root: provenanceRoot, outbox: path.join(provenanceRoot, 'managed.json'), readRaw: async target => parseRating(target), write: async target => fs.promises.appendFile(target, '|rating=2'), links: root => root === fs.realpathSync(provenanceRoot) ? [{ shortcutPath, externalTargetRoot: externalFile, externalTargetKind: 'file', offline: false }] : [] });
    const managedResult = await managedService.writeChecked(provenanceRoot, externalFile, 2, fs.statSync(externalFile).mtimeMs);
    assert.strictEqual(managedResult.rating, 2, 'a workspace-managed external file must remain writable');
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(provenanceRoot, 'managed.json'), 'utf8')).items.length === 0);
    assert.strictEqual(fs.readdirSync(externalRoot).filter(name => name.startsWith('.photoflow-rating-')).length, 0);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write('media rating outbox tests passed\n');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
