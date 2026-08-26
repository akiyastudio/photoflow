const transfer = require('./file-transfer-service.cjs');
const identity = require('./file-identity-service.cjs');
const path = require('path');

const writeJournal = async (fs, journalPath, value, faultInjector = () => undefined) => {
  await fs.promises.mkdir(path.dirname(journalPath), { recursive: true });
  const temporary = `${journalPath}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${journalPath}.backup-${process.pid}-${Date.now()}`; let backedUp = false;
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  try { if (fs.existsSync(journalPath)) { await fs.promises.rename(journalPath, backup); backedUp = true; } await faultInjector('after-backup-before-replace', { journalPath }); await fs.promises.rename(temporary, journalPath); if (backedUp) await fs.promises.rm(backup, { force: true }); }
  catch (error) { if (backedUp && !fs.existsSync(journalPath)) await fs.promises.rename(backup, journalPath).catch(() => undefined); throw error; }
  finally { await fs.promises.rm(temporary, { force: true }).catch(() => undefined); await fs.promises.rm(backup, { force: true }).catch(() => undefined); }
};

const createFileSystemService = ({ recycleBinService, fs = require('fs'), journalFaultInjector = () => undefined }) => ({
  ...transfer,
  ...identity,
  move: (source, destination, options) => transfer.movePathAtomic(source, destination, options),
  createDirectory: targetPath => fs.promises.mkdir(targetPath),
  ensureDirectory: targetPath => fs.promises.mkdir(targetPath, { recursive: true }),
  removeEmptyDirectory: targetPath => fs.promises.rmdir(targetPath),
  removeCreated: (targetPath, options = {}) => fs.promises.rm(targetPath, { recursive: options.directory === true, force: false }),
  trash: targetPath => recycleBinService.trash(targetPath),
  trashMany: targetPaths => recycleBinService.trashMany(targetPaths),
  trashManyJournaled: async ({ targetPaths, journalPath }) => {
    let journal = null;
    try { journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8')); } catch { /* new command */ }
    const normalizedTargets = [...new Set(targetPaths.map(target => path.resolve(target)))];
    if (journal?.state === 'applied') return journal.result;
    if (journal && (journal.kind !== 'file-operations-trash-v1' || JSON.stringify(journal.targets) !== JSON.stringify(normalizedTargets))) throw new Error('file_operation_trash_journal_conflict');
    if (!journal) { journal = { schemaVersion: 1, kind: 'file-operations-trash-v1', state: 'prepared', targets: normalizedTargets, createdAt: Date.now() }; await writeJournal(fs, journalPath, journal, journalFaultInjector); }
    if (journal.state === 'executing') { const present = normalizedTargets.map(target => fs.existsSync(target)); if (present.some(value => !value)) return { success: false, outcomeUnknown: true, code: 'TRASH_OUTCOME_UNKNOWN', items: [] }; }
    journal.state = 'executing'; journal.executingAt = Date.now(); await writeJournal(fs, journalPath, journal, journalFaultInjector);
    const result = await recycleBinService.trashMany(normalizedTargets);
    journal.state = 'applied'; journal.appliedAt = Date.now(); journal.result = result;
    await writeJournal(fs, journalPath, journal, journalFaultInjector);
    return result;
  },
  restore: item => recycleBinService.restore(item),
  probeRecycleItem: item => recycleBinService.probe(item),
});

module.exports = { createFileSystemService };
