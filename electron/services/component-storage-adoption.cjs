/** Safe, source-preserving adoption for a previously owned component storage generation. */
const digest = async (fs, crypto, filePath) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};
const copyTreeVerified = async ({ fs, path, crypto, source, destination, overwrite = false, metrics = { fileCount: 0, byteCount: 0 } }) => {
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('Legacy component storage contains a symbolic link');
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destination, { recursive: true });
    for (const entry of await fs.promises.readdir(source)) await copyTreeVerified({ fs, path, crypto, source: path.join(source, entry), destination: path.join(destination, entry), overwrite, metrics });
    return metrics;
  }
  if (!stat.isFile()) throw new Error('Legacy component storage contains an unsupported entry');
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
  if (await digest(fs, crypto, source) !== await digest(fs, crypto, destination)) throw new Error('Legacy component storage copy verification failed');
  metrics.fileCount += 1;
  metrics.byteCount += stat.size;
  return metrics;
};
const readReceipt = async (fs, filePath) => { try { return JSON.parse(await fs.promises.readFile(filePath, 'utf8')); } catch { return null; } };
const transactionPaths = (path, componentRoot, componentId) => {
  const parent = path.dirname(componentRoot);
  return {
    journal: path.join(parent, `.${componentId}.legacy-v1-adoption.json`),
    pending: path.join(parent, `.${componentId}.legacy-v1-adoption.pending`),
    previous: path.join(parent, `.${componentId}.legacy-v1-adoption.previous`),
  };
};
const writeJournal = async ({ fs, path, crypto, journal, value }) => {
  const temporary = `${journal}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.promises.rename(temporary, journal);
};
const recoverLegacyStorageV1 = async ({ fs, path, componentRoot, descriptor }) => {
  const transaction = transactionPaths(path, componentRoot, descriptor.componentId);
  const parent = path.dirname(transaction.journal);
  const journalTemporaryPrefix = `${path.basename(transaction.journal)}.`;
  for (const entry of await fs.promises.readdir(parent).catch(() => [])) {
    if (!entry.startsWith(journalTemporaryPrefix) || !entry.endsWith('.tmp')) continue;
    await fs.promises.rm(path.join(parent, entry), { force: true });
  }
  const journal = await readReceipt(fs, transaction.journal);
  const visibleReceipt = await readReceipt(fs, path.join(componentRoot, 'receipts', 'migrations', 'legacy-storage-v1.json'));
  if (visibleReceipt?.state === 'committed' && visibleReceipt.componentId === descriptor.componentId) {
    await fs.promises.rm(transaction.pending, { recursive: true, force: true });
    await fs.promises.rm(transaction.previous, { recursive: true, force: true });
    await fs.promises.rm(transaction.journal, { force: true });
    return visibleReceipt;
  }
  if (!journal) {
    if (!fs.existsSync(componentRoot) && fs.existsSync(transaction.previous)) await fs.promises.rename(transaction.previous, componentRoot);
    if (!fs.existsSync(componentRoot) && fs.existsSync(transaction.pending)) {
      const pendingStat = await fs.promises.lstat(transaction.pending);
      const pendingReceipt = pendingStat.isDirectory() && !pendingStat.isSymbolicLink()
        ? await readReceipt(fs, path.join(transaction.pending, 'receipts', 'migrations', 'legacy-storage-v1.json')) : null;
      if (pendingReceipt?.state === 'committed' && pendingReceipt.componentId === descriptor.componentId) {
        await fs.promises.rename(transaction.pending, componentRoot);
        return pendingReceipt;
      }
    }
    await fs.promises.rm(transaction.pending, { recursive: true, force: true });
    if (fs.existsSync(componentRoot)) await fs.promises.rm(transaction.previous, { recursive: true, force: true });
    return null;
  }
  if (journal.componentId !== descriptor.componentId || journal.kind !== 'component-storage-adoption') throw new Error('Legacy component storage adoption journal has an invalid identity');
  if (!fs.existsSync(componentRoot) && fs.existsSync(transaction.previous)) {
    await fs.promises.rename(transaction.previous, componentRoot);
  } else if (!fs.existsSync(componentRoot) && fs.existsSync(transaction.pending)) {
    const pendingStat = await fs.promises.lstat(transaction.pending);
    const pendingReceipt = pendingStat.isDirectory() && !pendingStat.isSymbolicLink()
      ? await readReceipt(fs, path.join(transaction.pending, 'receipts', 'migrations', 'legacy-storage-v1.json')) : null;
    if (pendingReceipt?.state !== 'committed' || pendingReceipt.componentId !== descriptor.componentId) {
      await fs.promises.rm(transaction.pending, { recursive: true, force: true });
      await fs.promises.rm(transaction.journal, { force: true });
      return null;
    }
    await fs.promises.rename(transaction.pending, componentRoot);
    const committed = await readReceipt(fs, path.join(componentRoot, 'receipts', 'migrations', 'legacy-storage-v1.json'));
    if (committed?.state !== 'committed' || committed.componentId !== descriptor.componentId) throw new Error('Recovered component storage package has no committed receipt');
    await fs.promises.rm(transaction.journal, { force: true });
    return committed;
  }
  await fs.promises.rm(transaction.pending, { recursive: true, force: true });
  await fs.promises.rm(transaction.previous, { recursive: true, force: true });
  await fs.promises.rm(transaction.journal, { force: true });
  return null;
};
const adoptLegacyStorageV1 = async ({ fs, path, crypto, dataRoot, componentRoot, descriptor, faultInjector = () => undefined }) => {
  const receiptRelative = path.join('receipts', 'migrations', 'legacy-storage-v1.json');
  const recovered = await recoverLegacyStorageV1({ fs, path, componentRoot, descriptor });
  if (recovered) return recovered;
  const existing = await readReceipt(fs, path.join(componentRoot, receiptRelative));
  if (existing?.state === 'committed' && existing?.componentId === descriptor.componentId) return existing;
  const legacyDataRoot = path.join(dataRoot, descriptor.componentId);
  const legacyDatabasePath = path.join(dataRoot, 'databases', `${descriptor.componentId}.sqlite3`);
  const legacyData = await fs.promises.lstat(legacyDataRoot).catch(() => null);
  const legacyDatabase = await fs.promises.lstat(legacyDatabasePath).catch(() => null);
  if (!legacyData && !legacyDatabase) return null;
  if ((legacyData && (!legacyData.isDirectory() || legacyData.isSymbolicLink())) || (legacyDatabase && (!legacyDatabase.isFile() || legacyDatabase.isSymbolicLink()))) throw new Error('Legacy component storage source is unsafe');
  const parent = path.dirname(componentRoot);
  const transaction = transactionPaths(path, componentRoot, descriptor.componentId);
  const { pending, previous } = transaction;
  let movedPrevious = false;
  await fs.promises.mkdir(parent, { recursive: true });
  try {
    const copied = { fileCount: 0, byteCount: 0 };
    if (legacyData) await copyTreeVerified({ fs, path, crypto, source: legacyDataRoot, destination: pending, metrics: copied });
    else await fs.promises.mkdir(pending, { recursive: true });
    if (legacyDatabase) {
      const destination = path.join(pending, 'storage.sqlite3');
      await copyTreeVerified({ fs, path, crypto, source: legacyDatabasePath, destination, metrics: copied });
      for (const suffix of ['-wal', '-shm']) {
        const source = `${legacyDatabasePath}${suffix}`;
        if (await fs.promises.lstat(source).catch(() => null)) await copyTreeVerified({ fs, path, crypto, source, destination: `${destination}${suffix}`, metrics: copied });
      }
    }
    if (fs.existsSync(componentRoot)) await copyTreeVerified({ fs, path, crypto, source: componentRoot, destination: pending, overwrite: true, metrics: copied });
    const receipt = { schemaVersion: 1, kind: 'component-storage-adoption', state: 'committed', componentId: descriptor.componentId, fromHostApiVersion: 1, toHostApiVersion: 2, adoptedDataRoot: Boolean(legacyData), adoptedDatabase: Boolean(legacyDatabase), legacyDataRoot: legacyData ? legacyDataRoot : '', legacyDatabasePath: legacyDatabase ? legacyDatabasePath : '', databaseSha256: legacyDatabase ? await digest(fs, crypto, legacyDatabasePath) : '', copiedFileCount: copied.fileCount, copiedByteCount: copied.byteCount, adoptedAt: Date.now() };
    const receiptPath = path.join(pending, receiptRelative);
    await fs.promises.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.promises.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await faultInjector('before-journal');
    await writeJournal({ fs, path, crypto, journal: transaction.journal, value: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'prepared', componentId: descriptor.componentId, pending, previous, componentRoot, preparedAt: Date.now() } });
    await faultInjector('after-prepared');
    if (fs.existsSync(componentRoot)) { await fs.promises.rename(componentRoot, previous); movedPrevious = true; }
    await faultInjector('after-previous-rename');
    await fs.promises.rename(pending, componentRoot);
    await faultInjector('after-commit-rename');
    if (movedPrevious) await fs.promises.rm(previous, { recursive: true, force: true });
    await fs.promises.rm(transaction.journal, { force: true });
    return receipt;
  } catch (error) {
    if (error?.code === 'SIMULATED_PROCESS_CRASH') throw error;
    await fs.promises.rm(pending, { recursive: true, force: true }).catch(() => undefined);
    if (movedPrevious && !fs.existsSync(componentRoot)) await fs.promises.rename(previous, componentRoot).catch(() => undefined);
    await fs.promises.rm(transaction.journal, { force: true }).catch(() => undefined);
    throw error;
  }
};
module.exports = { adoptLegacyStorageV1, copyTreeVerified, recoverLegacyStorageV1, transactionPaths };
