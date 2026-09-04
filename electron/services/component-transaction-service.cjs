const { componentTreeIdentityDigest, componentTreeIdentityReceipt, validatePreparedSidecarReceipts } = require('../component-package-archive.cjs');
const pathApi = require('node:path');

const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TOKEN = /^[a-zA-Z0-9._-]{1,180}$/;
const SCHEMA_VERSION = 2;
const MAX_TRANSACTION_JOURNAL_BYTES = 64 * 1024 * 1024;
const INSTALL_PHASES = new Set(['prepared', 'backup-moved', 'published', 'host-committing', 'committed', 'blocked']);
const UNINSTALL_PHASES = new Set(['prepared', 'quarantined', 'cleanup-pending', 'committed', 'blocked']);
const CLEANUP_STATES = new Set(['pending', 'executing', 'applied']);
const TRANSACTION_CLEANUP_PHASES = new Set(['pending', 'prepared', 'data-complete', 'finalized']);
const CLEANUP_ROLES = new Map([
  ['rollback-runtime', ['install', 'destination', 'destinationIdentity', 'destinationTreeIdentity']],
  ['rollback-staging', ['install', 'sourcePath', 'sourceIdentity', 'sourceTreeIdentity']],
  ['committed-backup', ['install', 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity']],
  ['uninstall-runtime', ['uninstall', 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity']],
]);

const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const nodeIdentity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const sameNode = (left, right) => left && right && left.dev === right.dev
  && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
const readExact = async (handle, size) => {
  const buffer = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const result = await handle.read(buffer, offset, size - offset, offset); if (!result.bytesRead) throw new Error('组件事务日志读取提前结束'); offset += result.bytesRead; }
  return buffer;
};
const validNode = value => value === null || exact(value, ['dev', 'ino', 'birthtimeMs'])
  && ['dev', 'ino', 'birthtimeMs'].every(key => Number.isFinite(value[key]));
const validPath = value => typeof value === 'string' && value.length <= 32767 && !value.includes('\0');
const validTree = value => { try { componentTreeIdentityReceipt(value); return true; } catch { return false; } };
const validCleanup = value => Array.isArray(value) && value.length <= 10000
  && value.every(step => exact(step, ['name', 'state']) && TOKEN.test(step.name) && CLEANUP_STATES.has(step.state));
const validCleanupReceipt = (value, phase) => {
  if (!plain(value) || typeof value.path !== 'string' || value.kind !== 'directory' || !validNode(value.nodeIdentity) || !/^[a-f0-9]{64}$/.test(value.treeDigest || '')) return false;
  const baseKeys = ['path', 'kind', 'nodeIdentity', 'treeDigest'];
  if (phase === 'pending') return exact(value, baseKeys);
  if (!exact(value, [...baseKeys, 'sidecarReceipts', 'cleanupPhase']) || value.cleanupPhase !== 'prepared') return false;
  try { validatePreparedSidecarReceipts(value); return true; } catch { return false; }
};
const validTransactionCleanup = value => Array.isArray(value) && value.length <= 8 && value.every(item => exact(item, ['name', 'pathField', 'identityField', 'treeField', 'phase', 'receipt'])
  && TOKEN.test(item.name) && ['destination', 'sourcePath', 'quarantinePath'].includes(item.pathField)
  && ['destinationIdentity', 'sourceIdentity', 'quarantineIdentity'].includes(item.identityField)
  && ['destinationTreeIdentity', 'sourceTreeIdentity', 'quarantineTreeIdentity'].includes(item.treeField)
  && TRANSACTION_CLEANUP_PHASES.has(item.phase) && validCleanupReceipt(item.receipt, item.phase));
const validateCleanupBindings = value => {
  const expectedContainer = pathApi.join(value.installRoot, value.componentId);
  const expectedDestination = pathApi.join(expectedContainer, 'runtime');
  const legacyUninstall = value.kind === 'uninstall' && value.container === expectedContainer && value.destination === expectedContainer && value.sourcePath === expectedContainer;
  const runtimeLayout = value.container === expectedContainer && value.destination === expectedDestination;
  if (value.kind === 'install' ? !runtimeLayout : !(legacyUninstall || runtimeLayout && [expectedDestination, expectedContainer].includes(value.sourcePath))) throw new Error('组件事务路径结构无效');
  const directChild = candidate => pathApi.dirname(candidate) === value.installRoot;
  if (value.kind === 'install') {
    if (!directChild(value.sourcePath) || !pathApi.basename(value.sourcePath).startsWith(`.${value.componentId}-install-`) || value.quarantinePath !== pathApi.join(value.installRoot, `.${value.componentId}-quarantine-${value.operationId}`)) throw new Error('组件安装事务暂存路径结构无效');
  } else if (value.quarantinePath !== pathApi.join(value.installRoot, `.${value.componentId}-uninstall-${value.operationId}`)) throw new Error('组件卸载事务路径结构无效');
  const names = new Set(); const fields = new Set();
  for (const item of value.cleanupItems) {
    const role = CLEANUP_ROLES.get(item.name);
    if (!role || role[0] !== value.kind || role[1] !== item.pathField || role[2] !== item.identityField || role[3] !== item.treeField || names.has(item.name) || fields.has(item.pathField)) throw new Error('组件事务 cleanup role 绑定无效');
    names.add(item.name); fields.add(item.pathField);
    if (!value[item.pathField] || item.receipt.path !== value[item.pathField] || !sameNode(item.receipt.nodeIdentity, value[item.identityField]) || item.receipt.treeDigest !== componentTreeIdentityDigest(value[item.treeField])) throw new Error('组件事务 cleanup receipt 与事务路径身份不匹配');
    const relative = pathApi.relative(value.installRoot, item.receipt.path);
    if (!relative || pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`)) throw new Error('组件事务 cleanup receipt 越过安装根目录');
  }
};

const validateJournal = value => {
  const keys = ['schemaVersion', 'kind', 'operationId', 'generation', 'componentId', 'phase', 'installRoot', 'installRootIdentity', 'container', 'destination', 'sourcePath', 'quarantinePath', 'destinationIdentity', 'sourceIdentity', 'quarantineIdentity', 'destinationTreeIdentity', 'sourceTreeIdentity', 'quarantineTreeIdentity', 'previousInstalled', 'previousEnabled', 'desiredEnabled', 'clearUserData', 'cleanupSteps', 'cleanupItems', 'lastError', 'updatedAt'];
  if (!exact(value, keys) || value.schemaVersion !== SCHEMA_VERSION || !['install', 'uninstall'].includes(value.kind) || !TOKEN.test(value.operationId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || !COMPONENT_ID.test(value.componentId)
    || !['installRoot', 'container', 'destination', 'sourcePath', 'quarantinePath'].every(key => validPath(value[key]))
    || !validNode(value.installRootIdentity) || value.installRootIdentity === null || !validNode(value.destinationIdentity) || !validNode(value.sourceIdentity) || !validNode(value.quarantineIdentity)
    || !validTree(value.destinationTreeIdentity) || !validTree(value.sourceTreeIdentity) || !validTree(value.quarantineTreeIdentity)
    || typeof value.previousInstalled !== 'boolean' || typeof value.previousEnabled !== 'boolean' || typeof value.desiredEnabled !== 'boolean' || typeof value.clearUserData !== 'boolean'
    || !validCleanup(value.cleanupSteps) || !validTransactionCleanup(value.cleanupItems) || typeof value.lastError !== 'string' || value.lastError.length > 4000 || !Number.isFinite(value.updatedAt)) throw new Error('组件事务日志 schema 无效');
  if (value.kind === 'install' ? !INSTALL_PHASES.has(value.phase) : !UNINSTALL_PHASES.has(value.phase)) throw new Error('组件事务日志阶段无效');
  if (value.kind === 'install' && (value.clearUserData || value.cleanupSteps.length)) throw new Error('组件安装事务不得包含卸载 cleanup plan');
  validateCleanupBindings(value);
  return value;
};

const existing = async (fs, target) => fs.promises.lstat(target).catch(error => {
  if (error?.code === 'ENOENT') return null;
  throw error;
});
const syncDirectory = async (fs, directory) => {
  let handle;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Node/Windows cannot open directory handles with the durability flags used by fsync.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBADF', 'EINVAL'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};
const atomicJson = async ({ fs, path, crypto, filePath, value, deleteOwnedFile }) => {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_TRANSACTION_JOURNAL_BYTES) throw new Error('组件事务日志超过安全上限');
  let handle;
  let temporaryReceipt = null;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    temporaryReceipt = { path: temporary, nodeIdentity: nodeIdentity(await handle.stat()), size: Buffer.byteLength(serialized), sha256: require('node:crypto').createHash('sha256').update(serialized).digest('hex') };
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, filePath);
    const published = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let receipt;
    try {
      const before = await published.stat(); const first = await readExact(published, before.size); const second = await readExact(published, before.size);
      const after = await published.stat(); const linked = await fs.promises.lstat(filePath);
      if (!before.isFile() || linked.isSymbolicLink() || !first.equals(second) || !first.equals(Buffer.from(serialized, 'utf8')) || !sameNode(nodeIdentity(before), nodeIdentity(after)) || !sameNode(nodeIdentity(after), nodeIdentity(linked)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.mtimeMs !== linked.mtimeMs || after.ctimeMs !== linked.ctimeMs) throw new Error('组件事务日志发布后复核失败');
      receipt = { path: filePath, nodeIdentity: nodeIdentity(after), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, sha256: require('node:crypto').createHash('sha256').update(first).digest('hex') };
    } finally { await published.close().catch(() => undefined); }
    await syncDirectory(fs, directory);
    return receipt;
  } finally {
    await handle?.close().catch(() => undefined);
    const remaining = await existing(fs, temporary);
    if (remaining) {
      if (!temporaryReceipt || typeof deleteOwnedFile !== 'function') throw new Error('组件事务临时日志清理缺少对象身份绑定删除服务');
      await deleteOwnedFile(temporaryReceipt);
    }
  }
};

const assertManagedPath = async ({ fs, path, root, target, allowMissing = false, label = '组件路径' }) => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!validPath(target)) throw new Error(`${label}无效`);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some(segment => segment.includes(':'))) throw new Error(`${label}越过受管根目录或包含数据流`);
  const rootStat = await fs.promises.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('组件安装根目录不是安全的普通目录');
  const canonicalRoot = await fs.promises.realpath(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await existing(fs, current);
    if (!stat) {
      if (allowMissing) break;
      throw Object.assign(new Error(`${label}不存在`), { code: 'ENOENT' });
    }
    if (stat.isSymbolicLink()) throw new Error(`${label}包含链接或重解析点`);
    const canonical = await fs.promises.realpath(current);
    const canonicalRelative = path.relative(canonicalRoot, canonical);
    if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) throw new Error(`${label}真实路径越过受管根目录`);
  }
  return { root: resolvedRoot, target: resolvedTarget, rootIdentity: nodeIdentity(rootStat) };
};

const createComponentTransactionService = ({ fs, path, crypto, installRoot, captureTreeIdentity, verifyTreeIdentity, cleanupOwnedPath, finalizeOwnedPath, deleteOwnedFile, getComponentEnabled = () => true, setComponentEnabled = () => undefined, clearComponentEnabledState = () => undefined, recoverInstallHostState = async () => undefined, cleanupProvider = () => [], onBlocked = () => undefined, onUnblocked = () => undefined, onCorrupt = () => undefined, now = Date.now, fault = async () => undefined }) => {
  const root = path.resolve(installRoot);
  const journalRoot = path.join(root, '.transactions');
  const active = new Map();
  const recoveries = new Map();
  let globalRecovery = null;
  let installRootIdentity = null;
  let journalRootIdentity = null;
  const journalReceipts = new Map();
  const busyError = message => Object.assign(new Error(message), { code: 'COMPONENT_LIFECYCLE_BUSY' });
  const beginActiveOperation = (componentId, kind) => {
    if (globalRecovery || recoveries.has(componentId) || active.has(componentId)) throw busyError('组件事务或恢复正在进行');
    let resolveSettled;
    const operation = {
      kind,
      settled: new Promise(resolve => { resolveSettled = resolve; }),
      release: () => {
        if (active.get(componentId) !== operation) return;
        active.delete(componentId);
        resolveSettled();
      },
    };
    active.set(componentId, operation);
    return operation;
  };
  const fileFor = componentId => path.join(journalRoot, `${componentId}.json`);
  const readJournal = async filePath => {
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 2 || before.size > MAX_TRANSACTION_JOURNAL_BYTES) throw new Error('组件事务日志类型或大小无效');
      const first = await readExact(handle, before.size); const second = await readExact(handle, before.size);
      const after = await handle.stat(); const linked = await fs.promises.lstat(filePath);
      const text = first.toString('utf8');
      if (!after.isFile() || linked.isSymbolicLink() || !first.equals(second) || !Buffer.from(text, 'utf8').equals(first) || !sameNode(nodeIdentity(before), nodeIdentity(after)) || !sameNode(nodeIdentity(after), nodeIdentity(linked)) || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.mtimeMs !== linked.mtimeMs || after.ctimeMs !== linked.ctimeMs) throw new Error('组件事务日志在读取期间被替换');
      return { text, receipt: { path: filePath, nodeIdentity: nodeIdentity(after), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, sha256: require('node:crypto').createHash('sha256').update(first).digest('hex') } };
    } finally { await handle.close().catch(() => undefined); }
  };
  const ensureRoots = async () => {
    await fs.promises.mkdir(root, { recursive: true });
    await assertManagedPath({ fs, path, root, target: journalRoot, allowMissing: true, label: '组件事务目录' });
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const rootStat = await fs.promises.lstat(root);
    if (installRootIdentity && !sameNode(installRootIdentity, nodeIdentity(rootStat))) throw new Error('组件安装根目录身份发生变化');
    installRootIdentity ||= nodeIdentity(rootStat);
    const stat = await fs.promises.lstat(journalRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('组件事务目录不是安全的普通目录');
    if (journalRootIdentity && !sameNode(journalRootIdentity, nodeIdentity(stat))) throw new Error('组件事务目录身份发生变化');
    journalRootIdentity ||= nodeIdentity(stat);
  };
  const persist = async record => {
    await ensureRoots();
    const next = validateJournal({ ...record, generation: record.generation + 1, updatedAt: now() });
    await fault(`journal:${next.kind}:${next.phase}`, next);
    const journalPath = fileFor(next.componentId);
    const currentReceipt = journalReceipts.get(next.componentId);
    const linked = await existing(fs, journalPath);
    if (record.generation === 0) {
      if (linked || currentReceipt) throw new Error('组件事务首次 journal 发布检测到已有对象');
    } else {
      if (!linked || !currentReceipt || currentReceipt.operationId !== record.operationId || currentReceipt.generation !== record.generation) throw new Error('组件事务 journal generation CAS 前置条件不满足');
      const current = await readJournal(journalPath); const parsed = validateJournal(JSON.parse(current.text));
      if (parsed.operationId !== record.operationId || parsed.generation !== record.generation || !sameNode(current.receipt.nodeIdentity, currentReceipt.nodeIdentity) || current.receipt.size !== currentReceipt.size || current.receipt.sha256 !== currentReceipt.sha256) throw new Error('组件事务 journal 在 generation CAS 前已变化');
    }
    const receipt = await atomicJson({ fs, path, crypto, filePath: journalPath, value: next, deleteOwnedFile });
    journalReceipts.set(next.componentId, { ...receipt, operationId: next.operationId, generation: next.generation });
    return next;
  };
  const removeJournal = async record => {
    await ensureRoots();
    const receipt = journalReceipts.get(record.componentId);
    if (!receipt || receipt.operationId !== record.operationId || receipt.generation !== record.generation || typeof deleteOwnedFile !== 'function') throw new Error('组件事务日志删除缺少当前 generation 对象身份收据');
    await deleteOwnedFile(receipt);
    await syncDirectory(fs, journalRoot);
    journalReceipts.delete(record.componentId);
    onUnblocked(record.componentId);
  };
  const assertReceipt = async (target, expected, label) => {
    const stat = await fs.promises.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameNode(nodeIdentity(stat), expected)) throw new Error(`${label}身份发生变化`);
  };
  const verifyReceipt = async (record, pathField, identityField, treeField, label) => {
    const target = record[pathField];
    await assertManagedPath({ fs, path, root, target, label });
    await assertReceipt(target, record[identityField], label);
    await verifyTreeIdentity(target, record[treeField]);
  };
  const cleanupSpecification = (name, pathField, identityField, treeField) => ({ name, pathField, identityField, treeField });
  const transactionCleanup = async (original, specification, label) => {
    let record = original;
    const target = record[specification.pathField];
    const identity = record[specification.identityField];
    const tree = record[specification.treeField];
    if (!target || !identity) return record;
    if (typeof cleanupOwnedPath !== 'function' || typeof finalizeOwnedPath !== 'function') throw new Error('组件事务缺少统一 prepared cleanup provider');
    try {
      let item = record.cleanupItems.find(candidate => candidate.name === specification.name);
      if (!item) {
        if (!(await existing(fs, target))) {
          const destination = await existing(fs, record.destination);
          const consumedByPublication = specification.pathField === 'sourcePath' && destination && sameNode(nodeIdentity(destination), identity);
          const consumedByFinalizedRollback = specification.pathField === 'sourcePath' && record.cleanupItems.some(candidate => candidate.name === 'rollback-runtime' && candidate.phase === 'finalized' && sameNode(candidate.receipt.nodeIdentity, identity));
          if (consumedByPublication || consumedByFinalizedRollback) return record;
          throw new Error(`${label}缺失且没有 prepared cleanup 证明`);
        }
        await verifyReceipt(record, specification.pathField, specification.identityField, specification.treeField, label);
        item = { ...specification, phase: 'pending', receipt: { path: target, kind: 'directory', nodeIdentity: identity, treeDigest: componentTreeIdentityDigest(tree) } };
        record = await persist({ ...record, cleanupItems: [...record.cleanupItems, item] });
      }
      const update = async (phase, receipt = item.receipt) => {
        item = { ...item, phase, receipt };
        record = await persist({ ...record, cleanupItems: record.cleanupItems.map(candidate => candidate.name === item.name ? item : candidate) });
      };
      if (item.phase === 'pending' || item.phase === 'prepared') {
        await fault(`cleanup:${item.phase}:${item.name}`, record);
        const result = await cleanupOwnedPath(item.receipt, { persistPrepared: async preparedReceipt => { await update('prepared', preparedReceipt); return true; } });
        if (item.phase !== 'prepared') throw new Error('组件事务 cleanup 在 native delete 前未持久化 prepared receipt');
        await update('data-complete', result?.preparedReceipt || item.receipt);
      }
      if (item.phase === 'data-complete') {
        await fault(`cleanup:data-complete:${item.name}`, record);
        await finalizeOwnedPath(item.receipt);
        await update('finalized');
        await fault(`cleanup:finalized:${item.name}`, record);
      }
      return record;
    } catch (error) {
      error.transactionRecord = record;
      throw error;
    }
  };
  const base = ({ kind, operationId = crypto.randomUUID(), componentId, container, destination, sourcePath = '', quarantinePath = '', destinationIdentity = null, sourceIdentity = null, quarantineIdentity = null, destinationTreeIdentity = [], sourceTreeIdentity = [], quarantineTreeIdentity = [], previousInstalled = true, previousEnabled, desiredEnabled, clearUserData = false, cleanupSteps = [] }) => validateJournal({
    schemaVersion: SCHEMA_VERSION, kind, operationId, generation: 1, componentId, phase: 'prepared', installRoot: root, installRootIdentity, container: path.resolve(container), destination: path.resolve(destination), sourcePath: sourcePath ? path.resolve(sourcePath) : '', quarantinePath: quarantinePath ? path.resolve(quarantinePath) : '', destinationIdentity, sourceIdentity, quarantineIdentity, destinationTreeIdentity, sourceTreeIdentity, quarantineTreeIdentity, previousInstalled, previousEnabled, desiredEnabled, clearUserData, cleanupSteps, cleanupItems: [], lastError: '', updatedAt: now(),
  });
  const block = async (record, error, phase = 'blocked') => {
    onBlocked(record.componentId, error);
    try {
      return await persist({ ...record, phase, lastError: String(error?.message || error).slice(0, 4000) });
    } catch (journalError) {
      throw new AggregateError([error, journalError], '组件事务失败且阻断状态无法持久化');
    }
  };
  const validateCleanupPlan = record => {
    const expected = cleanupProvider(record.componentId, record.clearUserData, record).map(step => step.name);
    const actual = record.cleanupSteps.map(step => step.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected) || new Set(actual).size !== actual.length || !record.clearUserData && actual.length) throw new Error('组件卸载 cleanup plan 与当前 provider 不匹配');
    let stage = 'applied'; let executing = 0;
    for (const step of record.cleanupSteps) {
      if (step.state === 'applied') { if (stage !== 'applied') throw new Error('组件卸载 cleanup 状态序列无效'); }
      else if (step.state === 'executing') { if (stage === 'pending' || ++executing > 1) throw new Error('组件卸载 cleanup 状态序列无效'); stage = 'executing'; }
      else { stage = 'pending'; }
    }
    return true;
  };
  const restoreInstall = async original => {
    let record = original;
    try {
      const sourceStat = record.sourcePath ? await existing(fs, record.sourcePath) : null;
      const destinationStat = await existing(fs, record.destination);
      const backupStat = record.quarantinePath ? await existing(fs, record.quarantinePath) : null;
      const backupAlreadyRestored = Boolean(destinationStat && !backupStat && record.quarantineIdentity
        && sameNode(nodeIdentity(destinationStat), record.quarantineIdentity));
      // A missing source plus the staging receipt proves rename(source, destination) completed
      // even if the following journal update never reached disk.
      if (destinationStat && !backupAlreadyRestored && !record.destinationIdentity && !sourceStat && record.sourceIdentity) {
        record = { ...record, destinationIdentity: record.sourceIdentity, destinationTreeIdentity: record.sourceTreeIdentity };
      }
      if (destinationStat && !backupAlreadyRestored && (!record.destinationIdentity || !sameNode(nodeIdentity(destinationStat), record.destinationIdentity))) throw new Error('组件目标被未知实体占用，无法恢复');
      if (!backupAlreadyRestored && record.destinationIdentity) record = await transactionCleanup(record, cleanupSpecification('rollback-runtime', 'destination', 'destinationIdentity', 'destinationTreeIdentity'), '待回滚的新组件 runtime');
      if (backupStat) {
        await verifyReceipt(record, 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity', '旧组件 quarantine');
        if (await existing(fs, record.destination)) throw new Error('组件目标被占用，无法恢复旧 runtime');
        await fault('install:restore-backup', record);
        await fs.promises.rename(record.quarantinePath, record.destination);
        await assertReceipt(record.destination, record.quarantineIdentity, '恢复的旧组件 runtime');
        await verifyTreeIdentity(record.destination, record.quarantineTreeIdentity);
      }
      if (record.sourceIdentity) record = await transactionCleanup(record, cleanupSpecification('rollback-staging', 'sourcePath', 'sourceIdentity', 'sourceTreeIdentity'), '组件发布暂存目录');
      if (record.previousInstalled) {
        await assertReceipt(record.destination, record.quarantineIdentity, '恢复启用前的旧组件 runtime');
        await verifyTreeIdentity(record.destination, record.quarantineTreeIdentity);
      } else if (await existing(fs, record.destination)) throw new Error('首次安装回滚提交前检测到 replacement runtime');
      if (record.previousInstalled) setComponentEnabled(record.componentId, record.previousEnabled);
      else clearComponentEnabledState(record.componentId);
      await removeJournal(record);
      return { kind: 'install', componentId: record.componentId, operationId: record.operationId, status: 'rolled-back' };
    } catch (error) {
      record = error.transactionRecord || record;
      error.code ||= 'COMPONENT_TRANSACTION_BLOCKED';
      error.journal = await block(record, error);
      throw error;
    }
  };
  const cleanupCommittedInstall = async record => {
    try {
      if (record.quarantinePath && record.quarantineIdentity) {
        await fault('install:cleanup-backup', record);
        record = await transactionCleanup(record, cleanupSpecification('committed-backup', 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity'), '已提交组件备份');
      }
      if (record.cleanupItems.some(item => item.phase !== 'finalized')) throw new Error('组件安装 cleanup 尚未全部 finalized');
      await verifyReceipt(record, 'destination', 'destinationIdentity', 'destinationTreeIdentity', '启用前的新组件 runtime');
      setComponentEnabled(record.componentId, record.desiredEnabled);
      await removeJournal(record);
      return { kind: 'install', componentId: record.componentId, operationId: record.operationId, status: 'committed' };
    } catch (error) {
      record = error.transactionRecord || record;
      // committed is the forward-only commit point; cleanup failure must never roll back it.
      error.code ||= 'COMPONENT_TRANSACTION_CLEANUP_PENDING';
      error.journal = await block(record, error, 'committed');
      throw error;
    }
  };
  const install = async ({ componentId, container, destination, stagingPath, stagingIdentity, stagingTreeIdentity, previousInstalled = true, previousEnabled = getComponentEnabled(componentId), desiredEnabled = true, validatePublished, commitHostState, onAdmitted = () => undefined }) => {
    if (!COMPONENT_ID.test(componentId)) throw new Error('组件 ID 无效');
    const activeOperation = beginActiveOperation(componentId, 'install');
    let record;
    let publicationStarted = false;
    let hostCommitted = false;
    try {
      await ensureRoots();
      await assertManagedPath({ fs, path, root, target: container, label: '组件容器' });
      await assertManagedPath({ fs, path, root, target: stagingPath, label: '组件发布暂存目录' });
      await assertReceipt(stagingPath, stagingIdentity, '组件发布暂存目录');
      await verifyTreeIdentity(stagingPath, stagingTreeIdentity);

      const old = await existing(fs, destination);
      let oldIdentity = null;
      let oldTree = [];
      if (old) {
        if (!old.isDirectory() || old.isSymbolicLink()) throw new Error('现有组件 runtime 不是安全的普通目录');
        oldIdentity = nodeIdentity(old);
        oldTree = await captureTreeIdentity(destination);
      }

      const operationId = crypto.randomUUID();
      const quarantinePath = path.join(root, `.${componentId}-quarantine-${operationId}`);
      record = await persist({
        ...base({
          kind: 'install', operationId, componentId, container, destination, sourcePath: stagingPath, quarantinePath,
          sourceIdentity: stagingIdentity, sourceTreeIdentity: stagingTreeIdentity,
          quarantineIdentity: oldIdentity, quarantineTreeIdentity: oldTree,
          previousInstalled, previousEnabled, desiredEnabled,
        }),
        generation: 0,
      });
      onAdmitted(record.operationId);

      // prepared is durable before the old runtime is moved out of its executable path.
      if (old) {
        await fault('install:rename-backup', record);
        publicationStarted = true;
        await fs.promises.rename(destination, quarantinePath);
        await assertReceipt(quarantinePath, oldIdentity, '旧组件 quarantine');
        await verifyTreeIdentity(quarantinePath, oldTree);
        record = await persist({ ...record, phase: 'backup-moved' });
      }

      await fault('install:publish', record);
      publicationStarted = true;
      await fs.promises.rename(stagingPath, destination);
      const publishedIdentity = nodeIdentity(await fs.promises.lstat(destination));
      record = await persist({
        ...record,
        phase: 'published',
        destinationIdentity: publishedIdentity,
        destinationTreeIdentity: stagingTreeIdentity,
        sourceIdentity: null,
        sourceTreeIdentity: [],
      });
      await verifyReceipt(record, 'destination', 'destinationIdentity', 'destinationTreeIdentity', '新组件 runtime');
      await validatePublished(destination);

      // host-committing is replayed forward after a crash; pre-commit phases roll back.
      record = await persist({ ...record, phase: 'host-committing' });
      await commitHostState(destination, desiredEnabled);
      hostCommitted = true;
      record = await persist({ ...record, phase: 'committed' });
      await cleanupCommittedInstall(record);
      return { operationId: record.operationId, status: 'committed' };
    } catch (error) {
      if (error?.simulateCrash === true) throw error;
      if (hostCommitted && record) {
        record = error.transactionRecord || error.journal || record;
        if (error.journal) throw error;
        try {
          if (record.phase !== 'committed') record = await persist({ ...record, phase: 'committed' });
          await cleanupCommittedInstall(record);
          return { operationId: record.operationId, status: 'committed' };
        } catch (forwardError) {
          record = forwardError.transactionRecord || forwardError.journal || record;
          if (forwardError.journal) throw forwardError;
          forwardError.code ||= 'COMPONENT_TRANSACTION_BLOCKED';
          forwardError.journal = await block(record, forwardError, 'committed');
          throw forwardError;
        }
      }
      if (record && (publicationStarted || record.phase !== 'prepared' || !(await existing(fs, stagingPath)))) await restoreInstall(record);
      else if (record) {
        try { await removeJournal(record); }
        catch (journalError) {
          const failure = new AggregateError([error, journalError], '组件安装失败且事务日志清理未确认');
          failure.code = 'COMPONENT_TRANSACTION_BLOCKED';
          failure.journal = await block(record, failure);
          throw failure;
        }
      }
      throw error;
    }
    finally {
      activeOperation.release();
    }
  };
  const advanceCleanup = async original => {
    let record = original;
    validateCleanupPlan(record);
    const handlers = new Map(cleanupProvider(record.componentId, record.clearUserData, record).map(step => [step.name, step.run]));
    for (let index = 0; index < record.cleanupSteps.length; index += 1) {
      const step = record.cleanupSteps[index];
      if (step.state === 'applied') continue;
      const run = handlers.get(step.name);
      if (typeof run !== 'function') throw new Error(`组件清理步骤不可恢复：${step.name}`);
      try {
        if (step.state === 'pending') {
          const steps = record.cleanupSteps.map((item, itemIndex) => itemIndex === index ? { ...item, state: 'executing' } : item);
          record = await persist({ ...record, phase: 'cleanup-pending', cleanupSteps: steps });
        }
        await fault(`uninstall:cleanup:${step.name}`, record);
        await run(record.quarantinePath, record);
        const steps = record.cleanupSteps.map((item, itemIndex) => itemIndex === index ? { ...item, state: 'applied' } : item);
        record = await persist({ ...record, phase: 'cleanup-pending', cleanupSteps: steps });
      } catch (error) {
        error.code ||= 'COMPONENT_DATA_CLEANUP_FAILED';
        error.journal = await block(record, error, 'cleanup-pending');
        throw error;
      }
    }
    return record;
  };
  const finishUninstall = async record => {
    let current = record;
    try {
      current = await advanceCleanup(current);
      current = await transactionCleanup(current, cleanupSpecification('uninstall-runtime', 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity'), '卸载组件 runtime');
      if (current.cleanupItems.some(item => item.phase !== 'finalized')) throw new Error('组件卸载 cleanup 尚未全部 finalized');
      if (await existing(fs, current.sourcePath) || current.destination !== current.sourcePath && await existing(fs, current.destination)) throw new Error('组件卸载提交前检测到 replacement runtime');
      clearComponentEnabledState(current.componentId);
      current = await persist({ ...current, phase: 'committed' });
      await removeJournal(current);
      return { kind: 'uninstall', componentId: current.componentId, operationId: current.operationId, status: 'committed', clearUserData: current.clearUserData, cleanupSteps: current.cleanupSteps.map(step => step.name) };
    } catch (error) {
      current = error.transactionRecord || current;
      if (error.journal) throw error;
      error.code ||= 'COMPONENT_UNINSTALL_CLEANUP_PENDING';
      error.journal = await block(current, error, 'cleanup-pending');
      throw error;
    }
  };
  const ensureUninstallQuarantined = async original => {
    let record = original;
    const source = await existing(fs, record.sourcePath);
    const quarantine = await existing(fs, record.quarantinePath);
    if (source && quarantine) throw new Error('卸载源与 quarantine 同时存在，无法判定归属');
    if (source) {
      await verifyReceipt(record, 'sourcePath', 'sourceIdentity', 'sourceTreeIdentity', '卸载源');
      setComponentEnabled(record.componentId, false);
      await fault('uninstall:quarantine', record);
      await fs.promises.rename(record.sourcePath, record.quarantinePath);
      await assertReceipt(record.quarantinePath, record.sourceIdentity, '卸载 quarantine');
      await verifyTreeIdentity(record.quarantinePath, record.sourceTreeIdentity);
      record = await persist({
        ...record,
        phase: 'quarantined',
        quarantineIdentity: record.sourceIdentity,
        quarantineTreeIdentity: record.sourceTreeIdentity,
        sourceIdentity: null,
        sourceTreeIdentity: [],
      });
    }
    else if (quarantine) {
      // prepared + source missing + matching quarantine proves the rename completed.
      if (!record.quarantineIdentity && record.sourceIdentity) {
        record = { ...record, quarantineIdentity: record.sourceIdentity, quarantineTreeIdentity: record.sourceTreeIdentity };
      }
      await verifyReceipt(record, 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity', '卸载 quarantine');
      if (record.phase === 'prepared') record = await persist({ ...record, phase: 'quarantined' });
    }
    else {
      const runtimeCleanup = record.cleanupItems.find(item => item.name === 'uninstall-runtime');
      if (!runtimeCleanup || runtimeCleanup.phase === 'pending') throw new Error('卸载源与 quarantine 均不存在，无法安全恢复');
    }
    return record;
  };
  const uninstall = async ({ componentId, container, destination, targetPath, targetIdentity, targetTreeIdentity, clearUserData, previousEnabled = getComponentEnabled(componentId) }) => {
    if (!COMPONENT_ID.test(componentId)) throw new Error('组件 ID 无效');
    const activeOperation = beginActiveOperation(componentId, 'uninstall');
    let record;
    let quarantined = false;
    try {
      await ensureRoots();
      await assertManagedPath({ fs, path, root, target: targetPath, label: '卸载目标' });
      await assertReceipt(targetPath, targetIdentity, '卸载目标');
      await verifyTreeIdentity(targetPath, targetTreeIdentity);
      const steps = cleanupProvider(componentId, clearUserData).map(step => ({ name: step.name, state: 'pending' }));
      const operationId = crypto.randomUUID();
      const initialRecord = {
        ...base({
          kind: 'uninstall', operationId, componentId, container, destination, sourcePath: targetPath,
          quarantinePath: path.join(root, `.${componentId}-uninstall-${operationId}`),
          sourceIdentity: targetIdentity, sourceTreeIdentity: targetTreeIdentity,
          previousEnabled, desiredEnabled: false, clearUserData, cleanupSteps: steps,
        }),
        generation: 0,
      };
      validateCleanupPlan(initialRecord);
      record = await persist(initialRecord);
      // Once quarantined, runtime remains persistently disabled until every cleanup receipt is applied.
      record = await ensureUninstallQuarantined(record);
      quarantined = true;
      return await finishUninstall(record);
    }
    catch (error) {
      if (error?.simulateCrash === true) throw error;
      if (!quarantined && record && await existing(fs, record.sourcePath)) {
        setComponentEnabled(componentId, previousEnabled);
        try { await removeJournal(record); }
        catch (journalError) {
          const failure = new AggregateError([error, journalError], '组件卸载失败且事务日志清理未确认');
          failure.code = 'COMPONENT_TRANSACTION_BLOCKED';
          failure.journal = await block(record, failure);
          throw failure;
        }
      }
      else if (record && !error.journal) error.journal = await block(record, error, 'cleanup-pending');
      throw error;
    }
    finally {
      activeOperation.release();
    }
  };
  const recoverOnce = async (componentIdFilter = '') => {
    await ensureRoots();
    const entries = await fs.promises.readdir(journalRoot, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const hintedId = entry.name.slice(0, -5);
      if (componentIdFilter && hintedId !== componentIdFilter) continue;
      try {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('组件事务日志不是普通文件');
        const journalPath = path.join(journalRoot, entry.name);
        const loaded = await readJournal(journalPath);
        const record = validateJournal(JSON.parse(loaded.text));
        if (record.installRoot !== root || !sameNode(record.installRootIdentity, installRootIdentity) || entry.name !== `${record.componentId}.json`) throw new Error('组件事务日志归属无效');
        journalReceipts.set(record.componentId, { ...loaded.receipt, operationId: record.operationId, generation: record.generation });
        for (const target of [record.container, record.destination, record.sourcePath, record.quarantinePath].filter(Boolean)) {
          await assertManagedPath({ fs, path, root, target, allowMissing: true, label: '事务路径' });
        }
        validateCleanupPlan(record);
        onBlocked(record.componentId, new Error('组件事务正在恢复'));
        if (record.kind === 'install') {
          if (record.phase === 'host-committing') {
            await verifyReceipt(record, 'destination', 'destinationIdentity', 'destinationTreeIdentity', '待提交的新组件 runtime');
            await recoverInstallHostState(record.componentId, record.destination, record.desiredEnabled);
            const committed = await persist({ ...record, phase: 'committed' });
            results.push(await cleanupCommittedInstall(committed));
          } else results.push(record.phase === 'committed' ? await cleanupCommittedInstall(record) : await restoreInstall(record));
        } else {
          const quarantinedRecord = await ensureUninstallQuarantined(record);
          results.push(await finishUninstall(quarantinedRecord));
        }
      } catch (error) {
        if (COMPONENT_ID.test(hintedId)) onBlocked(hintedId, error);
        else onCorrupt(error);
        results.push({ componentId: hintedId, status: 'blocked', error: error.message || String(error) });
      }
    }
    return results;
  };
  const startFilteredRecovery = componentId => {
    if (active.has(componentId)) return Promise.reject(busyError('组件事务正在进行，不能并发恢复'));
    const existingRecovery = recoveries.get(componentId);
    if (existingRecovery) return existingRecovery;
    const operation = recoverOnce(componentId);
    const exposed = operation.finally(() => {
      if (recoveries.get(componentId) === exposed) recoveries.delete(componentId);
    });
    recoveries.set(componentId, exposed);
    return exposed;
  };
  const recover = componentIdFilter => {
    const componentId = String(componentIdFilter || '');
    if (componentId) {
      if (!globalRecovery) return startFilteredRecovery(componentId);
      // A filtered caller joins the global pass, then rechecks in case a journal
      // appeared after the global directory snapshot but before its commit point.
      return globalRecovery.then(results => {
        const componentResults = results.filter(result => result.componentId === componentId);
        return componentResults.length ? componentResults : startFilteredRecovery(componentId);
      });
    }
    if (globalRecovery) return globalRecovery;
    const operation = (async () => {
      // Yield once so globalRecovery is visible before new component operations
      // can attempt admission.
      await Promise.resolve();
      await Promise.allSettled([...recoveries.values()]);
      await Promise.all([...active.values()].map(item => item.settled));
      return recoverOnce('');
    })();
    const exposed = operation.finally(() => {
      if (globalRecovery === exposed) globalRecovery = null;
    });
    globalRecovery = exposed;
    return exposed;
  };
  return { active, install, uninstall, recover, journalRoot, validateJournal };
};

module.exports = { MAX_TRANSACTION_JOURNAL_BYTES, SCHEMA_VERSION, assertManagedPath, atomicJson, createComponentTransactionService, nodeIdentity, validateJournal };
