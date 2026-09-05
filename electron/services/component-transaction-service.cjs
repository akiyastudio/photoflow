const { componentTreeIdentityDigest, componentTreeIdentityReceipt, validatePreparedSidecarReceipts } = require('../component-package-archive.cjs');
const pathApi = require('node:path');

const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TOKEN = /^[a-zA-Z0-9._-]{1,180}$/;
const SCHEMA_VERSION = 2;
const MAX_TRANSACTION_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_TRANSACTION_STATE_BYTES = 4 * 1024 * 1024;
const INSTALL_PHASES = new Set(['prepared', 'backup-moved', 'published', 'host-committing', 'committed', 'rolled-back', 'finalized', 'blocked']);
const UNINSTALL_PHASES = new Set(['prepared', 'quarantined', 'cleanup-pending', 'committed', 'finalized', 'rolled-back', 'blocked']);
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
const sameOptionalNode = (left, right) => left === null && right === null || sameNode(left, right);
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
const validPreparationReceipt = (receipt, phase) => {
  if (!plain(receipt) || !validPath(receipt.path) || !validNode(receipt.nodeIdentity) || receipt.nodeIdentity === null || !['file', 'directory'].includes(receipt.kind)) return false;
  const baseKeys = receipt.kind === 'directory' ? ['path', 'kind', 'nodeIdentity', 'treeDigest'] : ['path', 'kind', 'nodeIdentity', 'size', 'sha256', 'mode'];
  if (receipt.kind === 'directory' ? !/^[a-f0-9]{64}$/.test(receipt.treeDigest || '') : !Number.isSafeInteger(receipt.size) || receipt.size < 0 || !/^[a-f0-9]{64}$/.test(receipt.sha256 || '') || !Number.isInteger(receipt.mode) || receipt.mode < 0 || receipt.mode > 0o777) return false;
  if (phase === 'pending') return exact(receipt, baseKeys);
  if (!exact(receipt, [...baseKeys, 'sidecarReceipts', 'cleanupPhase']) || receipt.cleanupPhase !== 'prepared') return false;
  try { validatePreparedSidecarReceipts(receipt); return true; } catch { return false; }
};
const validPreparationCleanup = value => Array.isArray(value) && (value.length === 0 || value.length === 2) && value.every(item => exact(item, ['name', 'phase', 'receipt']) && ['package-stage', 'package-snapshot'].includes(item.name) && TRANSACTION_CLEANUP_PHASES.has(item.phase) && validPreparationReceipt(item.receipt, item.phase))
  && (value.length === 0 || value[0].name === 'package-stage' && value[0].receipt.kind === 'directory' && value[1].name === 'package-snapshot' && value[1].receipt.kind === 'file');
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
  const runtimeUninstall = runtimeLayout && value.sourcePath === (value.clearUserData ? expectedContainer : expectedDestination);
  if (value.kind === 'install' ? !runtimeLayout : !(legacyUninstall || runtimeUninstall)) throw new Error('组件事务路径结构无效');
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
  const keys = ['schemaVersion', 'kind', 'operationId', 'generation', 'componentId', 'phase', 'installRoot', 'installRootIdentity', 'container', 'destination', 'sourcePath', 'quarantinePath', 'destinationIdentity', 'sourceIdentity', 'quarantineIdentity', 'destinationTreeIdentity', 'sourceTreeIdentity', 'quarantineTreeIdentity', 'previousInstalled', 'previousEnabled', 'desiredEnabled', 'clearUserData', 'cleanupSteps', 'cleanupItems', 'preparationCleanup', 'lastError', 'updatedAt'];
  if (!exact(value, keys) || value.schemaVersion !== SCHEMA_VERSION || !['install', 'uninstall'].includes(value.kind) || !TOKEN.test(value.operationId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || !COMPONENT_ID.test(value.componentId)
    || !['installRoot', 'container', 'destination', 'sourcePath', 'quarantinePath'].every(key => validPath(value[key]))
    || !validNode(value.installRootIdentity) || value.installRootIdentity === null || !validNode(value.destinationIdentity) || !validNode(value.sourceIdentity) || !validNode(value.quarantineIdentity)
    || !validTree(value.destinationTreeIdentity) || !validTree(value.sourceTreeIdentity) || !validTree(value.quarantineTreeIdentity)
    || typeof value.previousInstalled !== 'boolean' || typeof value.previousEnabled !== 'boolean' || typeof value.desiredEnabled !== 'boolean' || typeof value.clearUserData !== 'boolean'
    || !validCleanup(value.cleanupSteps) || !validTransactionCleanup(value.cleanupItems) || !validPreparationCleanup(value.preparationCleanup) || typeof value.lastError !== 'string' || value.lastError.length > 4000 || !Number.isFinite(value.updatedAt)) throw new Error('组件事务日志 schema 无效');
  if (value.kind === 'install' ? !INSTALL_PHASES.has(value.phase) : !UNINSTALL_PHASES.has(value.phase)) throw new Error('组件事务日志阶段无效');
  if (value.kind === 'install' && (value.clearUserData || value.cleanupSteps.length)) throw new Error('组件安装事务不得包含卸载 cleanup plan');
  validateCleanupBindings(value);
  return value;
};
const cleanupPhaseIndex = phase => ['pending', 'prepared', 'data-complete', 'finalized'].indexOf(phase);
const cleanupReceiptBase = receipt => receipt.kind === 'directory'
  ? { path: receipt.path, kind: receipt.kind, nodeIdentity: receipt.nodeIdentity, treeDigest: receipt.treeDigest }
  : { path: receipt.path, kind: receipt.kind, nodeIdentity: receipt.nodeIdentity, size: receipt.size, sha256: receipt.sha256, mode: receipt.mode };
const receiptTransitionValid = (prior, next) => JSON.stringify(cleanupReceiptBase(prior)) === JSON.stringify(cleanupReceiptBase(next))
  && (prior.cleanupPhase === 'prepared' ? JSON.stringify(prior) === JSON.stringify(next) : true);
const INSTALL_TRANSITIONS = new Map([
  ['prepared', new Set(['prepared', 'backup-moved', 'published', 'blocked', 'rolled-back'])], ['backup-moved', new Set(['backup-moved', 'published', 'blocked', 'rolled-back'])],
  ['published', new Set(['published', 'host-committing', 'blocked', 'rolled-back'])], ['host-committing', new Set(['host-committing', 'committed'])],
  ['committed', new Set(['committed', 'finalized'])], ['blocked', new Set(['blocked', 'rolled-back'])], ['rolled-back', new Set(['rolled-back'])], ['finalized', new Set(['finalized'])],
]);
const UNINSTALL_TRANSITIONS = new Map([
  ['prepared', new Set(['prepared', 'quarantined', 'blocked', 'rolled-back'])], ['quarantined', new Set(['quarantined', 'cleanup-pending', 'finalized'])],
  ['cleanup-pending', new Set(['cleanup-pending', 'finalized'])], ['blocked', new Set(['blocked', 'quarantined', 'cleanup-pending', 'rolled-back'])], ['committed', new Set(['committed', 'finalized'])], ['finalized', new Set(['finalized'])], ['rolled-back', new Set(['rolled-back'])],
]);
const validateMutableTransition = (previous, next) => {
  if (next.schemaVersion !== SCHEMA_VERSION || next.kind !== previous.kind || next.operationId !== previous.operationId || next.componentId !== previous.componentId || next.generation !== previous.generation + 1 || next.installRoot !== previous.installRoot || next.container !== previous.container || next.destination !== previous.destination || next.sourcePath !== previous.sourcePath || next.quarantinePath !== previous.quarantinePath) throw new Error('组件事务 mutable state 静态绑定发生变化');
  if (next.kind === 'install' ? !INSTALL_PHASES.has(next.phase) : !UNINSTALL_PHASES.has(next.phase)) throw new Error('组件事务 mutable phase 无效');
  if (!(next.kind === 'install' ? INSTALL_TRANSITIONS : UNINSTALL_TRANSITIONS).get(previous.phase)?.has(next.phase)) throw new Error('组件事务 phase transition 非法');
  if (!validNode(next.destinationIdentity) || !validNode(next.sourceIdentity) || !validNode(next.quarantineIdentity) || !validCleanup(next.cleanupSteps) || !validTransactionCleanup(next.cleanupItems) || !validPreparationCleanup(next.preparationCleanup) || typeof next.lastError !== 'string' || next.lastError.length > 4000 || !Number.isFinite(next.updatedAt)) throw new Error('组件事务 mutable state schema 无效');
  const changedNode = (before, after) => before !== null && after !== null && !sameNode(before, after);
  if (changedNode(previous.destinationIdentity, next.destinationIdentity) || changedNode(previous.sourceIdentity, next.sourceIdentity) || changedNode(previous.quarantineIdentity, next.quarantineIdentity) || previous.sourceIdentity === null && next.sourceIdentity !== null || previous.destinationIdentity !== null && next.destinationIdentity === null || previous.quarantineIdentity !== null && next.quarantineIdentity === null || previous.kind === 'install' && previous.quarantineIdentity === null && next.quarantineIdentity !== null || previous.kind === 'uninstall' && previous.destinationIdentity === null && next.destinationIdentity !== null) throw new Error('组件事务 identity 转移非法');
  const previousPreparation = new Map(previous.preparationCleanup.map(item => [item.name, item]));
  if (previous.preparationCleanup.length === 0 && next.preparationCleanup.length || next.preparationCleanup.length && next.preparationCleanup.some(item => { const prior = previousPreparation.get(item.name); return !prior || !receiptTransitionValid(prior.receipt, item.receipt) || cleanupPhaseIndex(item.phase) < cleanupPhaseIndex(prior.phase) || cleanupPhaseIndex(item.phase) - cleanupPhaseIndex(prior.phase) > 1; })) throw new Error('组件安装 preparation cleanup 倒退、跳级或重新出现');
  if (next.preparationCleanup.length === 0 && previous.preparationCleanup.length && previous.preparationCleanup.some(item => item.phase !== 'finalized')) throw new Error('组件安装 preparation cleanup 尚未 finalized');
  const previousCleanup = new Map(previous.cleanupItems.map(item => [item.name, item]));
  if (previous.cleanupItems.some(item => !next.cleanupItems.some(candidate => candidate.name === item.name))) throw new Error('组件事务 cleanup item 不得消失');
  for (const item of next.cleanupItems) { const prior = previousCleanup.get(item.name); if (!prior && item.phase !== 'pending' || prior && (item.pathField !== prior.pathField || item.identityField !== prior.identityField || item.treeField !== prior.treeField || !receiptTransitionValid(prior.receipt, item.receipt) || cleanupPhaseIndex(item.phase) < cleanupPhaseIndex(prior.phase) || cleanupPhaseIndex(item.phase) - cleanupPhaseIndex(prior.phase) > 1)) throw new Error('组件事务 cleanup item 倒退、跳级或换绑'); }
  if (JSON.stringify(previous.cleanupSteps.map(item => item.name)) !== JSON.stringify(next.cleanupSteps.map(item => item.name))) throw new Error('组件卸载 cleanup plan 不得变化');
  const cleanupStepChanges = next.cleanupSteps.map((item, index) => [previous.cleanupSteps[index]?.state, item.state]).filter(([before, after]) => before !== after);
  if (cleanupStepChanges.length > 1 || cleanupStepChanges.some(([before, after]) => !(before === 'pending' && after === 'executing' || before === 'executing' && after === 'applied'))) throw new Error('组件卸载 cleanup step transition 非法');
  if (previous.phase === 'finalized' && next.phase !== 'finalized' || previous.phase === 'rolled-back' && next.phase !== 'rolled-back') throw new Error('组件事务 terminal phase 不得倒退');
  return next;
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
const atomicJson = async ({ fs, path, crypto, filePath, value, deleteOwnedFile, publishNoReplace, maxBytes = MAX_TRANSACTION_JOURNAL_BYTES }) => {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(value)}\n`;
  const expectedBytes = Buffer.from(serialized, 'utf8');
  if (expectedBytes.length > maxBytes) throw new Error('组件事务日志超过安全上限');
  let handle;
  let temporaryReceipt = null;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    const temporaryStat = await handle.stat();
    temporaryReceipt = { path: temporary, nodeIdentity: nodeIdentity(temporaryStat), size: expectedBytes.length, mtimeMs: temporaryStat.mtimeMs, ctimeMs: temporaryStat.ctimeMs, sha256: require('node:crypto').createHash('sha256').update(expectedBytes).digest('hex') };
    await handle.close();
    handle = null;
    if (typeof publishNoReplace !== 'function') throw new Error('组件事务日志缺少 no-replace 发布服务');
    try { await publishNoReplace(temporary, filePath); }
    catch (error) {
      const [temporaryStillExists, targetExists] = await Promise.all([existing(fs, temporary), existing(fs, filePath)]);
      if (temporaryStillExists || !targetExists) throw error;
    }
    const published = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let receipt;
    try {
      const before = await published.stat();
      if (!before.isFile() || before.size !== expectedBytes.length || before.size > maxBytes) throw new Error('组件事务日志发布后大小无效');
      const first = await readExact(published, before.size); const second = await readExact(published, before.size);
      const after = await published.stat(); const linked = await fs.promises.lstat(filePath);
      if (linked.isSymbolicLink() || !first.equals(second) || !first.equals(expectedBytes) || !sameNode(nodeIdentity(before), nodeIdentity(after)) || !sameNode(nodeIdentity(after), nodeIdentity(linked)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.mtimeMs !== linked.mtimeMs || after.ctimeMs !== linked.ctimeMs) throw new Error('组件事务日志发布后复核失败');
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

const createComponentTransactionService = ({ fs, path, crypto, installRoot, preparationRoot = '', captureTreeIdentity, verifyTreeIdentity, cleanupOwnedPath, finalizeOwnedPath, deleteOwnedFile, deleteOwnedDirectory, publishNoReplace, getComponentEnabled = () => true, setComponentEnabled = () => undefined, clearComponentEnabledState = () => undefined, recoverInstallHostState = async () => undefined, cleanupProvider = () => [], onBlocked = () => undefined, onUnblocked = () => undefined, onCorrupt = () => undefined, now = Date.now, fault = async () => undefined }) => {
  const root = path.resolve(installRoot);
  const preparedRoot = preparationRoot ? path.resolve(preparationRoot) : '';
  const journalRoot = path.join(root, '.transactions');
  const active = new Map();
  const recoveries = new Map();
  let globalRecovery = null;
  let installRootIdentity = null;
  let journalRootIdentity = null;
  const journalReceipts = new Map();
  const busyError = message => Object.assign(new Error(message), { code: 'COMPONENT_LIFECYCLE_BUSY' });
  const latestRecord = (...records) => records.filter(record => record && Number.isSafeInteger(record.generation)).sort((left, right) => right.generation - left.generation)[0] || null;
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
  const fileFor = componentId => path.join(journalRoot, componentId);
  const receiptAt = directory => path.join(directory, 'receipt.json');
  const stateAt = (directory, generation) => path.join(directory, `state-${String(generation).padStart(8, '0')}.json`);
  const receiptFor = componentId => receiptAt(fileFor(componentId));
  const stateFor = (componentId, generation) => stateAt(fileFor(componentId), generation);
  const readJournal = async (filePath, maxBytes = MAX_TRANSACTION_JOURNAL_BYTES) => {
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 2 || before.size > maxBytes) throw new Error('组件事务日志类型或大小无效');
      const first = await readExact(handle, before.size); const second = await readExact(handle, before.size);
      const after = await handle.stat(); const linked = await fs.promises.lstat(filePath);
      const text = first.toString('utf8');
      if (!after.isFile() || linked.isSymbolicLink() || !first.equals(second) || !Buffer.from(text, 'utf8').equals(first) || !sameNode(nodeIdentity(before), nodeIdentity(after)) || !sameNode(nodeIdentity(after), nodeIdentity(linked)) || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.mtimeMs !== linked.mtimeMs || after.ctimeMs !== linked.ctimeMs) throw new Error('组件事务日志在读取期间被替换');
      return { text, receipt: { path: filePath, nodeIdentity: nodeIdentity(after), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, sha256: require('node:crypto').createHash('sha256').update(first).digest('hex') } };
    } finally { await handle.close().catch(() => undefined); }
  };
  const captureOrphanFile = async filePath => {
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat(); if (!before.isFile() || before.size > MAX_TRANSACTION_JOURNAL_BYTES) throw new Error('组件事务 orphan 文件无效');
      const first = await readExact(handle, before.size); const second = await readExact(handle, before.size); const after = await handle.stat(); const linked = await fs.promises.lstat(filePath);
      if (linked.isSymbolicLink() || !first.equals(second) || !sameNode(nodeIdentity(before), nodeIdentity(after)) || !sameNode(nodeIdentity(after), nodeIdentity(linked)) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('组件事务 orphan 文件读取期间变化');
      return { path: filePath, nodeIdentity: nodeIdentity(after), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, sha256: require('node:crypto').createHash('sha256').update(first).digest('hex') };
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
  const immutableReceipt = record => ({
    schemaVersion: 1, kind: record.kind, operationId: record.operationId, componentId: record.componentId,
    installRoot: record.installRoot, installRootIdentity: record.installRootIdentity, container: record.container, destination: record.destination,
    sourcePath: record.sourcePath, quarantinePath: record.quarantinePath, initialSourceIdentity: record.sourceIdentity,
    initialQuarantineIdentity: record.quarantineIdentity, sourceTreeIdentity: record.sourceTreeIdentity,
    quarantineTreeIdentity: record.quarantineTreeIdentity, previousInstalled: record.previousInstalled, previousEnabled: record.previousEnabled,
    desiredEnabled: record.desiredEnabled, clearUserData: record.clearUserData, cleanupStepNames: record.cleanupSteps.map(step => step.name),
    preparationCleanup: record.preparationCleanup,
  });
  const statePayload = (record, receiptDigest, previousStateHash) => ({
    schemaVersion: 1, operationId: record.operationId, generation: record.generation, receiptDigest, previousStateHash,
    phase: record.phase, destinationIdentity: record.destinationIdentity, sourceIdentity: record.sourceIdentity,
    quarantineIdentity: record.quarantineIdentity, cleanupSteps: record.cleanupSteps, cleanupItems: record.cleanupItems,
    preparationCleanup: record.preparationCleanup, lastError: record.lastError, updatedAt: record.updatedAt,
  });
  const stateWithHash = payload => ({ ...payload, stateHash: require('node:crypto').createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
  const validateImmutableReceipt = receipt => {
    const keys = ['schemaVersion', 'kind', 'operationId', 'componentId', 'installRoot', 'installRootIdentity', 'container', 'destination', 'sourcePath', 'quarantinePath', 'initialSourceIdentity', 'initialQuarantineIdentity', 'sourceTreeIdentity', 'quarantineTreeIdentity', 'previousInstalled', 'previousEnabled', 'desiredEnabled', 'clearUserData', 'cleanupStepNames', 'preparationCleanup'];
    if (!exact(receipt, keys) || receipt.schemaVersion !== 1 || !['install', 'uninstall'].includes(receipt.kind) || !TOKEN.test(receipt.operationId) || !COMPONENT_ID.test(receipt.componentId) || !validNode(receipt.installRootIdentity) || !validNode(receipt.initialSourceIdentity) || !validNode(receipt.initialQuarantineIdentity) || !validTree(receipt.sourceTreeIdentity) || !validTree(receipt.quarantineTreeIdentity) || !Array.isArray(receipt.cleanupStepNames) || receipt.cleanupStepNames.some(name => !TOKEN.test(name)) || new Set(receipt.cleanupStepNames).size !== receipt.cleanupStepNames.length || !validPreparationCleanup(receipt.preparationCleanup) || !['installRoot', 'container', 'destination', 'sourcePath', 'quarantinePath'].every(key => validPath(receipt[key]))) throw new Error('组件事务 immutable receipt schema 无效');
    return receipt;
  };
  const validateStateSchema = state => {
    const keys = ['schemaVersion', 'operationId', 'generation', 'receiptDigest', 'previousStateHash', 'phase', 'destinationIdentity', 'sourceIdentity', 'quarantineIdentity', 'cleanupSteps', 'cleanupItems', 'preparationCleanup', 'lastError', 'updatedAt', 'stateHash'];
    if (!exact(state, keys) || state.schemaVersion !== 1 || !TOKEN.test(state.operationId) || !Number.isSafeInteger(state.generation) || state.generation < 1 || !/^[a-f0-9]{64}$/.test(state.receiptDigest || '') || state.previousStateHash && !/^[a-f0-9]{64}$/.test(state.previousStateHash) || !/^[a-f0-9]{64}$/.test(state.stateHash || '') || !validNode(state.destinationIdentity) || !validNode(state.sourceIdentity) || !validNode(state.quarantineIdentity) || !validCleanup(state.cleanupSteps) || !validTransactionCleanup(state.cleanupItems) || !validPreparationCleanup(state.preparationCleanup) || typeof state.lastError !== 'string' || state.lastError.length > 4000 || !Number.isFinite(state.updatedAt)) throw new Error('组件事务 mutable state schema 无效');
    return state;
  };
  const validateInitialState = (receipt, record) => {
    if (record.generation !== 1 || record.phase !== 'prepared' || record.destinationIdentity !== null || !sameOptionalNode(record.sourceIdentity, receipt.initialSourceIdentity) || !sameOptionalNode(record.quarantineIdentity, receipt.initialQuarantineIdentity) || record.cleanupItems.length || record.cleanupSteps.some(step => step.state !== 'pending') || JSON.stringify(record.cleanupSteps.map(step => step.name)) !== JSON.stringify(receipt.cleanupStepNames) || JSON.stringify(record.preparationCleanup) !== JSON.stringify(receipt.preparationCleanup)) throw new Error('组件事务 initial state 与 immutable receipt 不匹配');
    return record;
  };
  const immutableMetadata = receipt => ({ sourceTreeDigest: componentTreeIdentityDigest(receipt.sourceTreeIdentity), quarantineTreeDigest: componentTreeIdentityDigest(receipt.quarantineTreeIdentity) });
  const validateDynamicBindings = (record, receipt, metadata) => {
    const sourceMatches = sameOptionalNode(record.sourceIdentity, receipt.initialSourceIdentity) || record.sourceIdentity === null;
    if (record.kind === 'install') {
      const destinationMatches = record.destinationIdentity === null || sameNode(record.destinationIdentity, receipt.initialSourceIdentity);
      if (!destinationMatches || !sourceMatches || !sameOptionalNode(record.quarantineIdentity, receipt.initialQuarantineIdentity)) throw new Error('组件安装 identity 未绑定 immutable receipt');
      if (['published', 'host-committing', 'committed', 'finalized'].includes(record.phase) && (!sameNode(record.destinationIdentity, receipt.initialSourceIdentity) || record.sourceIdentity !== null)) throw new Error('组件安装 published identity 组合无效');
    } else {
      if (record.destinationIdentity !== null || !sourceMatches || !(record.quarantineIdentity === null || sameNode(record.quarantineIdentity, receipt.initialSourceIdentity))) throw new Error('组件卸载 identity 未绑定 immutable receipt');
      if (['quarantined', 'cleanup-pending', 'committed', 'finalized'].includes(record.phase) && (record.sourceIdentity !== null || !sameNode(record.quarantineIdentity, receipt.initialSourceIdentity))) throw new Error('组件卸载 quarantine identity 组合无效');
    }
    for (const item of record.cleanupItems) {
      const role = CLEANUP_ROLES.get(item.name); if (!role || role[0] !== record.kind || role[1] !== item.pathField || role[2] !== item.identityField || role[3] !== item.treeField) throw new Error('组件事务 cleanup role 无效');
      const expectedIdentity = item.pathField === 'destination' ? receipt.initialSourceIdentity : item.pathField === 'sourcePath' ? receipt.initialSourceIdentity : record.kind === 'install' ? receipt.initialQuarantineIdentity : receipt.initialSourceIdentity;
      const expectedTreeDigest = item.pathField === 'quarantinePath' && record.kind === 'install' ? metadata.quarantineTreeDigest : metadata.sourceTreeDigest;
      if (item.receipt.path !== record[item.pathField] || !sameNode(item.receipt.nodeIdentity, expectedIdentity) || item.receipt.treeDigest !== expectedTreeDigest) throw new Error('组件事务 cleanup item 未绑定 immutable receipt');
    }
    if (record.preparationCleanup.length) for (const item of record.preparationCleanup) { const initial = receipt.preparationCleanup.find(candidate => candidate.name === item.name); if (!initial || !receiptTransitionValid(initial.receipt, item.receipt)) throw new Error('组件安装 preparation cleanup 未绑定 immutable receipt'); }
    if (record.kind === 'install' && record.phase === 'finalized' && (record.preparationCleanup.some(item => item.phase !== 'finalized') || record.cleanupItems.some(item => item.phase !== 'finalized'))) throw new Error('组件安装 terminal state cleanup 不完整');
    if (record.kind === 'install' && record.phase === 'rolled-back' && record.cleanupItems.some(item => item.phase !== 'finalized')) throw new Error('组件安装 rollback terminal state cleanup 不完整');
    if (record.kind === 'uninstall' && record.phase === 'finalized' && (record.cleanupSteps.some(step => step.state !== 'applied') || !record.cleanupItems.some(item => item.name === 'uninstall-runtime' && item.phase === 'finalized'))) throw new Error('组件卸载 terminal state cleanup 不完整');
    return record;
  };
  const reconstructRecord = (receipt, state) => ({
    schemaVersion: SCHEMA_VERSION, kind: receipt.kind, operationId: receipt.operationId, generation: state.generation,
    componentId: receipt.componentId, phase: state.phase, installRoot: receipt.installRoot, installRootIdentity: receipt.installRootIdentity,
    container: receipt.container, destination: receipt.destination, sourcePath: receipt.sourcePath, quarantinePath: receipt.quarantinePath,
    destinationIdentity: state.destinationIdentity, sourceIdentity: state.sourceIdentity, quarantineIdentity: state.quarantineIdentity,
    destinationTreeIdentity: state.destinationIdentity ? receipt.sourceTreeIdentity : [],
    sourceTreeIdentity: state.sourceIdentity ? receipt.sourceTreeIdentity : [],
    quarantineTreeIdentity: state.quarantineIdentity ? (receipt.kind === 'install' ? receipt.quarantineTreeIdentity : receipt.sourceTreeIdentity) : [],
    previousInstalled: receipt.previousInstalled, previousEnabled: receipt.previousEnabled, desiredEnabled: receipt.desiredEnabled,
    clearUserData: receipt.clearUserData, cleanupSteps: state.cleanupSteps, cleanupItems: state.cleanupItems,
    preparationCleanup: state.preparationCleanup, lastError: state.lastError, updatedAt: state.updatedAt,
  });
  const assertJournalFiles = async tracking => {
    const directoryStat = await fs.promises.lstat(tracking.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !sameNode(nodeIdentity(directoryStat), tracking.directoryIdentity)) throw new Error('组件事务 journal 目录身份已变化');
    const canonicalRoot = await fs.promises.realpath(journalRoot); const canonicalDirectory = await fs.promises.realpath(tracking.directory); const relativeDirectory = path.relative(canonicalRoot, canonicalDirectory);
    if (!relativeDirectory || relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)) throw new Error('组件事务 journal 目录越过受管根目录');
    const entries = await fs.promises.readdir(tracking.directory, { withFileTypes: true });
    const expected = new Set(tracking.files.map(item => path.basename(item.path)));
    if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) || entries.length !== expected.size) throw new Error('组件事务 append-only journal 文件集合无效');
    const immutableStat = await fs.promises.lstat(receiptAt(tracking.directory)); const immutableReceiptFile = tracking.files[0];
    if (immutableStat.isSymbolicLink() || !sameNode(nodeIdentity(immutableStat), immutableReceiptFile.nodeIdentity) || immutableStat.size !== immutableReceiptFile.size || immutableStat.mtimeMs !== immutableReceiptFile.mtimeMs || immutableStat.ctimeMs !== immutableReceiptFile.ctimeMs) throw new Error('组件事务 immutable receipt 身份已变化');
    if (tracking.generation > 0) {
      const latestExpected = tracking.files.at(-1); const latest = await readJournal(stateAt(tracking.directory, tracking.generation), MAX_TRANSACTION_STATE_BYTES); const parsed = JSON.parse(latest.text);
      if (!sameNode(latest.receipt.nodeIdentity, latestExpected.nodeIdentity) || latest.receipt.size !== latestExpected.size || latest.receipt.sha256 !== latestExpected.sha256 || parsed.stateHash !== tracking.lastStateHash || parsed.generation !== tracking.generation || parsed.operationId !== tracking.operationId || parsed.receiptDigest !== tracking.receiptDigest) throw new Error('组件事务 predecessor state 已变化');
    }
  };
  const persist = async record => {
    await ensureRoots();
    const candidate = { ...record, generation: record.generation + 1, updatedAt: now() };
    const next = record.generation === 0 ? validateJournal(candidate) : validateMutableTransition(record, candidate);
    await fault(`journal:${next.kind}:${next.phase}`, next);
    let tracking = journalReceipts.get(next.componentId);
    if (record.generation === 0) {
      if (tracking || await existing(fs, fileFor(next.componentId))) throw new Error('组件事务首次 journal admission 检测到已有对象');
      const bundle = path.join(journalRoot, `.admit-${next.componentId}-${next.operationId}`);
      await fs.promises.mkdir(bundle, { recursive: false });
      let admitted = false;
      try {
        const bundleStat = await fs.promises.lstat(bundle); const canonicalJournalRoot = await fs.promises.realpath(journalRoot); const canonicalBundle = await fs.promises.realpath(bundle);
        if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink() || path.dirname(bundle) !== journalRoot || path.relative(canonicalJournalRoot, canonicalBundle).startsWith('..')) throw new Error('组件事务 admission bundle 路径无效');
        const immutable = validateImmutableReceipt(immutableReceipt(next));
        const metadata = immutableMetadata(immutable);
        const receiptFile = await atomicJson({ fs, path, crypto, filePath: receiptAt(bundle), value: immutable, deleteOwnedFile, publishNoReplace });
        const firstState = validateStateSchema(stateWithHash(statePayload(next, receiptFile.sha256, '')));
        validateInitialState(immutable, next); validateDynamicBindings(next, immutable, metadata);
        await atomicJson({ fs, path, crypto, filePath: stateAt(bundle, 1), value: firstState, deleteOwnedFile, publishNoReplace, maxBytes: MAX_TRANSACTION_STATE_BYTES });
        await syncDirectory(fs, bundle);
        try { await publishNoReplace(bundle, fileFor(next.componentId)); }
        catch (moveError) { if (!(await existing(fs, fileFor(next.componentId)))) throw moveError; }
        await syncDirectory(fs, journalRoot);
        const directoryStat = await fs.promises.lstat(fileFor(next.componentId));
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('组件事务 admission bundle 发布类型无效');
        const verifiedReceipt = await readJournal(receiptFor(next.componentId)); const verifiedState = await readJournal(stateFor(next.componentId, 1), MAX_TRANSACTION_STATE_BYTES);
        if (verifiedReceipt.receipt.sha256 !== receiptFile.sha256 || JSON.parse(verifiedState.text).stateHash !== firstState.stateHash) throw new Error('组件事务 admission bundle 发布复核失败');
        admitted = true;
        tracking = { componentId: next.componentId, operationId: next.operationId, generation: 1, directory: fileFor(next.componentId), directoryIdentity: nodeIdentity(directoryStat), receiptDigest: verifiedReceipt.receipt.sha256, lastStateHash: firstState.stateHash, files: [verifiedReceipt.receipt, verifiedState.receipt], immutable, metadata };
        journalReceipts.set(next.componentId, tracking);
        await assertJournalFiles(tracking);
        return next;
      } catch (error) {
        if (admitted || await existing(fs, fileFor(next.componentId))) { error.transactionRecord = next; error.admitted = true; error.outcomeUnknown = true; if (!admitted) { error.ownershipUnknown = true; onCorrupt(error); } }
        throw error;
      }
    }
    if (!tracking || tracking.operationId !== record.operationId || tracking.generation !== record.generation) throw new Error('组件事务 append-only generation 前置条件不满足');
    await assertJournalFiles(tracking);
    validateDynamicBindings(next, tracking.immutable, tracking.metadata);
    const state = validateStateSchema(stateWithHash(statePayload(next, tracking.receiptDigest, tracking.lastStateHash)));
    let stateFile = null;
    try {
      stateFile = await atomicJson({ fs, path, crypto, filePath: stateFor(next.componentId, next.generation), value: state, deleteOwnedFile, publishNoReplace, maxBytes: MAX_TRANSACTION_STATE_BYTES });
      tracking.generation = next.generation; tracking.lastStateHash = state.stateHash; tracking.files.push(stateFile);
      await syncDirectory(fs, tracking.directory);
      return next;
    } catch (error) { if (stateFile) { error.transactionRecord = next; error.admitted = true; error.outcomeUnknown = true; } throw error; }
  };
  const removeJournal = async record => {
    await ensureRoots();
    const tracking = journalReceipts.get(record.componentId);
    if (!tracking || tracking.operationId !== record.operationId || tracking.generation !== record.generation || typeof deleteOwnedFile !== 'function' || typeof deleteOwnedDirectory !== 'function') throw new Error('组件事务日志删除缺少当前 append-only identity 收据');
    if (!['rolled-back', 'finalized'].includes(record.phase)) throw new Error('组件事务未进入 durable terminal state');
    try {
      if (!tracking.gcMode) await assertJournalFiles(tracking);
      let gcFile = tracking.files.find(item => path.basename(item.path) === 'gc.json');
      if (!gcFile) {
        gcFile = await atomicJson({ fs, path, crypto, filePath: path.join(tracking.directory, 'gc.json'), value: { schemaVersion: 1, operationId: record.operationId, generation: record.generation, terminalStateHash: tracking.lastStateHash }, deleteOwnedFile, publishNoReplace, maxBytes: MAX_TRANSACTION_STATE_BYTES });
        tracking.files.push(gcFile); await syncDirectory(fs, tracking.directory);
      }
      const immutableFile = tracking.files.find(item => path.basename(item.path) === 'receipt.json');
      const stateFiles = tracking.files.filter(item => /^state-\d{8}\.json$/.test(path.basename(item.path))).sort((left, right) => left.path.localeCompare(right.path));
      const terminalState = stateFiles.pop();
      for (const receipt of stateFiles) await deleteOwnedFile(receipt);
      if (terminalState) await deleteOwnedFile(terminalState);
      if (immutableFile) await deleteOwnedFile(immutableFile);
      await deleteOwnedFile(gcFile);
      await deleteOwnedDirectory({ path: tracking.directory, nodeIdentity: tracking.directoryIdentity });
      await syncDirectory(fs, journalRoot);
      journalReceipts.delete(record.componentId);
      onUnblocked(record.componentId);
    } catch (error) {
      error.code ||= 'COMPONENT_TRANSACTION_GC_PENDING'; error.gcPending = true; error.cleanupPending = true; error.outcomeUnknown = true; error.transactionRecord = record; onBlocked(record.componentId, error); throw error;
    }
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
      if (!error.transactionRecord || Number(error.transactionRecord.generation || 0) < Number(record.generation || 0)) error.transactionRecord = record;
      throw error;
    }
  };
  const base = ({ kind, operationId = crypto.randomUUID(), componentId, container, destination, sourcePath = '', quarantinePath = '', destinationIdentity = null, sourceIdentity = null, quarantineIdentity = null, destinationTreeIdentity = [], sourceTreeIdentity = [], quarantineTreeIdentity = [], previousInstalled = true, previousEnabled, desiredEnabled, clearUserData = false, cleanupSteps = [], preparationCleanup = [] }) => ({
    schemaVersion: SCHEMA_VERSION, kind, operationId, generation: 1, componentId, phase: 'prepared', installRoot: root, installRootIdentity, container: path.resolve(container), destination: path.resolve(destination), sourcePath: sourcePath ? path.resolve(sourcePath) : '', quarantinePath: quarantinePath ? path.resolve(quarantinePath) : '', destinationIdentity, sourceIdentity, quarantineIdentity, destinationTreeIdentity, sourceTreeIdentity, quarantineTreeIdentity, previousInstalled, previousEnabled, desiredEnabled, clearUserData, cleanupSteps, cleanupItems: [], preparationCleanup, lastError: '', updatedAt: now(),
  });
  const block = async (record, error, phase = 'blocked') => {
    onBlocked(record.componentId, error);
    try {
      return await persist({ ...record, phase, lastError: String(error?.message || error).slice(0, 4000) });
    } catch (journalError) {
      const failure = new AggregateError([error, journalError], '组件事务失败且阻断状态无法持久化');
      failure.code = 'COMPONENT_TRANSACTION_BLOCKED'; failure.outcomeUnknown = true; failure.transactionRecord = record; failure.cleanupPending = true;
      throw failure;
    }
  };
  const validatePreparationAuthorization = (items, componentId, operationId, kind = 'install') => {
    if (kind === 'uninstall') { if (items.length) throw new Error('组件卸载不得包含 installation preparation cleanup'); return true; }
    if (!items.length) { if (preparedRoot) throw new Error('组件安装缺少 preparation cleanup 完整配对'); return true; }
    if (!preparedRoot || items.length !== 2) throw new Error('组件安装 preparation cleanup 缺少授权根目录或完整配对');
    const stage = items[0].receipt; const snapshot = items[1].receipt;
    if (path.dirname(stage.path) !== preparedRoot || path.basename(stage.path) !== `photoflow-component-package-${componentId}-${operationId}` || snapshot.path !== `${stage.path}.zip` || stage.kind !== 'directory' || snapshot.kind !== 'file') throw new Error('组件安装 preparation cleanup 路径授权无效');
    return true;
  };
  const completePreparationCleanup = async original => {
    if (!original.preparationCleanup.length) return original;
    let record = original;
    try {
      for (let index = 0; index < record.preparationCleanup.length; index += 1) {
        let item = record.preparationCleanup[index];
        const update = async (phase, receipt = item.receipt) => {
          item = { ...item, phase, receipt };
          record = await persist({ ...record, preparationCleanup: record.preparationCleanup.map((candidate, candidateIndex) => candidateIndex === index ? item : candidate) });
        };
        if (item.phase === 'pending' || item.phase === 'prepared') {
          await fault(`cleanup:${item.phase}:${item.name}`, record);
          const result = await cleanupOwnedPath(item.receipt, { persistPrepared: async preparedReceipt => { await update('prepared', preparedReceipt); return true; } });
          if (item.phase !== 'prepared') throw new Error('组件安装准备 cleanup 未在 native delete 前持久化 prepared receipt');
          await update('data-complete', result?.preparedReceipt || item.receipt);
        }
        if (item.phase === 'data-complete') {
          await fault(`cleanup:data-complete:${item.name}`, record);
          await finalizeOwnedPath(item.receipt);
          await update('finalized');
        }
      }
      if (record.preparationCleanup.some(item => item.phase !== 'finalized')) throw new Error('组件安装 preparation cleanup 尚未全部 finalized');
      return record;
    } catch (error) { error.transactionRecord = error.transactionRecord || record; error.cleanupPending = true; throw error; }
  };
  const verifyFinalizedCleanupProofs = async record => {
    for (const item of [...record.preparationCleanup, ...record.cleanupItems]) {
      if (item.phase !== 'finalized') throw new Error('组件事务 terminal cleanup proof 尚未 finalized');
      await finalizeOwnedPath(item.receipt);
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
      record = await completePreparationCleanup(record);
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
      await verifyFinalizedCleanupProofs(record);
      record = await persist({ ...record, phase: 'rolled-back' });
      if (record.previousInstalled) setComponentEnabled(record.componentId, record.previousEnabled);
      else clearComponentEnabledState(record.componentId);
      await removeJournal(record);
      return { kind: 'install', componentId: record.componentId, operationId: record.operationId, status: 'rolled-back' };
    } catch (error) {
      record = latestRecord(error.transactionRecord, error.journal, record);
      if (error.gcPending) throw error;
      error.code ||= 'COMPONENT_TRANSACTION_BLOCKED';
      error.journal = await block(record, error, record.phase === 'rolled-back' ? 'rolled-back' : 'blocked');
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
      await verifyFinalizedCleanupProofs(record);
      record = await persist({ ...record, phase: 'finalized' });
      setComponentEnabled(record.componentId, record.desiredEnabled);
      await removeJournal(record);
      return { kind: 'install', componentId: record.componentId, operationId: record.operationId, status: 'committed' };
    } catch (error) {
      record = latestRecord(error.transactionRecord, error.journal, record);
      if (error.gcPending) throw error;
      // committed is the forward-only commit point; cleanup failure must never roll back it.
      error.code ||= 'COMPONENT_TRANSACTION_CLEANUP_PENDING';
      error.journal = await block(record, error, record.phase === 'finalized' ? 'finalized' : 'committed');
      throw error;
    }
  };
  const install = async ({ operationId = crypto.randomUUID(), componentId, container, destination, stagingPath, stagingIdentity, stagingTreeIdentity, preparationCleanup = [], previousInstalled = true, previousEnabled = getComponentEnabled(componentId), desiredEnabled = true, validatePublished, commitHostState, onAdmitted = () => undefined }) => {
    if (!COMPONENT_ID.test(componentId)) throw new Error('组件 ID 无效');
    const activeOperation = beginActiveOperation(componentId, 'install');
    let record;
    let hostCommitted = false;
    try {
      if (preparationCleanup.length && (typeof cleanupOwnedPath !== 'function' || typeof finalizeOwnedPath !== 'function')) throw new Error('组件安装准备 cleanup provider 不完整');
      const preparationItems = preparationCleanup.length === 0 ? [] : [
        { name: 'package-stage', phase: 'pending', receipt: preparationCleanup.find(receipt => receipt.kind === 'directory') },
        { name: 'package-snapshot', phase: 'pending', receipt: preparationCleanup.find(receipt => receipt.kind === 'file') },
      ];
      if (!TOKEN.test(operationId)) throw new Error('组件事务 operation ID 无效');
      validatePreparationAuthorization(preparationItems, componentId, operationId, 'install');
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

      const quarantinePath = path.join(root, `.${componentId}-quarantine-${operationId}`);
      record = await persist({
        ...base({
          kind: 'install', operationId, componentId, container, destination, sourcePath: stagingPath, quarantinePath,
          sourceIdentity: stagingIdentity, sourceTreeIdentity: stagingTreeIdentity,
          quarantineIdentity: oldIdentity, quarantineTreeIdentity: oldTree,
          previousInstalled, previousEnabled, desiredEnabled, preparationCleanup: preparationItems,
        }),
        generation: 0,
      });
      onAdmitted(record.operationId);
      record = await completePreparationCleanup(record);

      // prepared is durable before the old runtime is moved out of its executable path.
      if (old) {
        await fault('install:rename-backup', record);
        await fs.promises.rename(destination, quarantinePath);
        await assertReceipt(quarantinePath, oldIdentity, '旧组件 quarantine');
        await verifyTreeIdentity(quarantinePath, oldTree);
        record = await persist({ ...record, phase: 'backup-moved' });
      }

      await fault('install:publish', record);
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
      record = latestRecord(error.transactionRecord, error.journal, record);
      if (!record && error?.admitted && error.transactionRecord) { record = error.transactionRecord; onAdmitted(record.operationId); }
      if (error?.ownershipUnknown) throw error;
      if (error?.gcPending) throw error;
      if (error?.simulateCrash === true) throw error;
      if (record?.phase === 'host-committing' && !hostCommitted) {
        error.code ||= 'COMPONENT_TRANSACTION_BLOCKED';
        error.journal = await block(error.transactionRecord || record, error, 'host-committing');
        throw error;
      }
      if (hostCommitted && record) {
        record = latestRecord(error.transactionRecord, error.journal, record);
        if (error.journal) throw error;
        try {
          if (record.phase !== 'committed') record = await persist({ ...record, phase: 'committed' });
          await cleanupCommittedInstall(record);
          return { operationId: record.operationId, status: 'committed' };
        } catch (forwardError) {
          record = latestRecord(forwardError.transactionRecord, forwardError.journal, record);
          if (forwardError.journal) throw forwardError;
          forwardError.code ||= 'COMPONENT_TRANSACTION_BLOCKED';
          forwardError.journal = await block(record, forwardError, 'committed');
          throw forwardError;
        }
      }
      if (record?.preparationCleanup?.some(item => item.phase !== 'finalized')) {
        error.code ||= 'COMPONENT_TRANSACTION_CLEANUP_PENDING';
        error.journal = await block(error.transactionRecord || record, error);
        throw error;
      }
      if (record) await restoreInstall(error.transactionRecord || record);
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
      await verifyFinalizedCleanupProofs(current);
      current = await persist({ ...current, phase: 'finalized' });
      clearComponentEnabledState(current.componentId);
      await removeJournal(current);
      return { kind: 'uninstall', componentId: current.componentId, operationId: current.operationId, status: 'committed', clearUserData: current.clearUserData, cleanupSteps: current.cleanupSteps.map(step => step.name) };
    } catch (error) {
      current = latestRecord(error.transactionRecord, error.journal, current);
      if (error.gcPending) throw error;
      if (error.journal) throw error;
      error.code ||= 'COMPONENT_UNINSTALL_CLEANUP_PENDING';
      error.journal = await block(current, error, current.phase === 'finalized' ? 'finalized' : 'cleanup-pending');
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
      await fault('uninstall:quarantine-renamed', record);
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
        record = { ...record, quarantineIdentity: record.sourceIdentity, quarantineTreeIdentity: record.sourceTreeIdentity, sourceIdentity: null, sourceTreeIdentity: [] };
      }
      await verifyReceipt(record, 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity', '卸载 quarantine');
      if (record.phase === 'prepared' || record.phase === 'blocked') record = await persist({ ...record, phase: 'quarantined' });
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
      record = latestRecord(error.transactionRecord, error.journal, record);
      if (error?.gcPending) throw error;
      if (error?.simulateCrash === true) throw error;
      if (!quarantined && record && await existing(fs, record.sourcePath)) {
        try {
          await verifyReceipt(record, 'sourcePath', 'sourceIdentity', 'sourceTreeIdentity', '取消卸载的组件 runtime');
          if (await existing(fs, record.quarantinePath)) throw new Error('取消卸载时 quarantine 被未知对象占用');
          record = await persist({ ...record, phase: 'rolled-back' });
          setComponentEnabled(componentId, previousEnabled);
          await removeJournal(record);
        }
        catch (journalError) {
          if (journalError.gcPending) throw journalError;
          const failure = new AggregateError([error, journalError], '组件卸载失败且事务日志清理未确认');
          failure.code = 'COMPONENT_TRANSACTION_BLOCKED';
          failure.journal = await block(record, failure);
          throw failure;
        }
      }
      else if (record && !error.journal) {
        const sourceMissingAfterPrepared = record.phase === 'prepared' && !(await existing(fs, record.sourcePath));
        if (sourceMissingAfterPrepared) error.outcomeUnknown = true;
        error.journal = await block(error.transactionRecord || record, error, sourceMissingAfterPrepared ? 'blocked' : 'cleanup-pending');
      }
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
      const hintedId = entry.name;
      if (componentIdFilter && hintedId !== componentIdFilter) continue;
      try {
        const orphanMatch = /^\.admit-([a-z0-9][a-z0-9._-]{0,79})-([a-f0-9-]{36})$/.exec(hintedId);
        if (orphanMatch) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('组件事务 admission orphan 类型无效');
          const orphanPath = path.join(journalRoot, hintedId); const orphanStat = await fs.promises.lstat(orphanPath); const orphanEntries = await fs.promises.readdir(orphanPath, { withFileTypes: true });
          if (orphanEntries.some(item => !item.isFile() || item.isSymbolicLink() || !/^(?:receipt\.json|state-00000001\.json|\..+\.tmp)$/.test(item.name))) throw new Error('组件事务 admission orphan 内容无效');
          for (const item of orphanEntries) await deleteOwnedFile(await captureOrphanFile(path.join(orphanPath, item.name)));
          await deleteOwnedDirectory({ path: orphanPath, nodeIdentity: nodeIdentity(orphanStat) }); await syncDirectory(fs, journalRoot);
          results.push({ componentId: orphanMatch[1], status: 'orphan-cleaned' }); continue;
        }
        if (!COMPONENT_ID.test(hintedId) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('组件事务 journal entry 不是合法组件目录');
        const directory = fileFor(hintedId); const directoryStat = await fs.promises.lstat(directory);
        const names = await fs.promises.readdir(directory, { withFileTypes: true });
        const stateNames = names.filter(item => /^state-\d{8}\.json$/.test(item.name)).map(item => item.name).sort();
        const hasReceipt = names.some(item => item.name === 'receipt.json');
        const hasGcMarker = names.some(item => item.name === 'gc.json');
        if (names.length === 0) { await deleteOwnedDirectory({ path: directory, nodeIdentity: nodeIdentity(directoryStat) }); await syncDirectory(fs, journalRoot); results.push({ componentId: hintedId, status: 'gc-complete' }); continue; }
        if (!hasReceipt || names.length !== stateNames.length + 1 + (hasGcMarker ? 1 : 0) || names.some(item => !item.isFile() || item.isSymbolicLink() || !/^receipt\.json$|^gc\.json$|^state-\d{8}\.json$/.test(item.name))) throw new Error('组件事务 append-only journal 文件集合损坏');
        const receiptLoaded = await readJournal(receiptFor(hintedId)); const immutable = validateImmutableReceipt(JSON.parse(receiptLoaded.text));
        if (immutable.componentId !== hintedId || immutable.installRoot !== root || !sameNode(immutable.installRootIdentity, installRootIdentity)) throw new Error('组件事务 immutable receipt 归属无效');
        const metadata = immutableMetadata(immutable);
        const gcLoaded = hasGcMarker ? await readJournal(path.join(directory, 'gc.json'), MAX_TRANSACTION_STATE_BYTES) : null;
        const gcMarker = gcLoaded ? JSON.parse(gcLoaded.text) : null;
        if (gcMarker && (!exact(gcMarker, ['schemaVersion', 'operationId', 'generation', 'terminalStateHash']) || gcMarker.schemaVersion !== 1 || gcMarker.operationId !== immutable.operationId || !Number.isSafeInteger(gcMarker.generation) || !/^[a-f0-9]{64}$/.test(gcMarker.terminalStateHash || ''))) throw new Error('组件事务 GC marker 无效');
        if (stateNames.length === 0) { if (!gcLoaded) throw new Error('组件事务 receipt-only 缺少 GC marker'); await deleteOwnedFile(receiptLoaded.receipt); await deleteOwnedFile(gcLoaded.receipt); await deleteOwnedDirectory({ path: directory, nodeIdentity: nodeIdentity(directoryStat) }); await syncDirectory(fs, journalRoot); results.push({ componentId: hintedId, status: 'gc-complete' }); continue; }
        const receiptDigest = receiptLoaded.receipt.sha256; let previousStateHash = ''; let record = null; const files = [receiptLoaded.receipt];
        const firstGeneration = Number(/^state-(\d{8})\.json$/.exec(stateNames[0])[1]); const partialGc = firstGeneration !== 1;
        for (let index = 0; index < stateNames.length; index += 1) {
          const generation = firstGeneration + index;
          if (stateNames[index] !== path.basename(stateFor(hintedId, generation))) throw new Error('组件事务 state generation 不连续');
          const loaded = await readJournal(path.join(directory, stateNames[index]), MAX_TRANSACTION_STATE_BYTES); const state = validateStateSchema(JSON.parse(loaded.text)); const { stateHash, ...payload } = state;
          if (!/^[a-f0-9]{64}$/.test(stateHash || '') || stateHash !== require('node:crypto').createHash('sha256').update(JSON.stringify(payload)).digest('hex') || state.generation !== generation || state.operationId !== immutable.operationId || state.receiptDigest !== receiptDigest || (!partialGc || index > 0) && state.previousStateHash !== previousStateHash) throw new Error('组件事务 state hash-chain 无效');
          const candidate = reconstructRecord(immutable, state);
          record = record ? validateMutableTransition(record, candidate) : validateJournal(candidate);
          if (state.generation === 1) validateInitialState(immutable, record);
          validateDynamicBindings(record, immutable, metadata);
          previousStateHash = stateHash; files.push(loaded.receipt);
        }
        if ((partialGc || gcMarker) && (!gcMarker || !['rolled-back', 'finalized'].includes(record.phase) || gcMarker.generation !== record.generation || gcMarker.terminalStateHash !== previousStateHash)) throw new Error('组件事务终态 GC chain 无效');
        if (record.installRoot !== root || !sameNode(record.installRootIdentity, installRootIdentity) || record.componentId !== hintedId) throw new Error('组件事务日志归属无效');
        if (gcLoaded) files.push(gcLoaded.receipt);
        journalReceipts.set(record.componentId, { componentId: record.componentId, operationId: record.operationId, generation: record.generation, directory, directoryIdentity: nodeIdentity(directoryStat), receiptDigest, lastStateHash: previousStateHash, files, gcMode: Boolean(partialGc || gcMarker), immutable, metadata });
        for (const target of [record.container, record.destination, record.sourcePath, record.quarantinePath].filter(Boolean)) {
          await assertManagedPath({ fs, path, root, target, allowMissing: true, label: '事务路径' });
        }
        validateCleanupPlan(record);
        validatePreparationAuthorization(record.preparationCleanup.length ? record.preparationCleanup : immutable.preparationCleanup, record.componentId, record.operationId, record.kind);
        onBlocked(record.componentId, new Error('组件事务正在恢复'));
        if (record.kind === 'install') {
          if (record.phase === 'finalized') {
            await verifyFinalizedCleanupProofs(record);
            await verifyReceipt(record, 'destination', 'destinationIdentity', 'destinationTreeIdentity', '恢复启用前的新组件 runtime');
            setComponentEnabled(record.componentId, record.desiredEnabled); await removeJournal(record);
            results.push({ kind: 'install', componentId: record.componentId, operationId: record.operationId, status: 'committed' });
          } else if (record.phase === 'rolled-back') {
            await verifyFinalizedCleanupProofs(record);
            if (record.previousInstalled) { await assertReceipt(record.destination, record.quarantineIdentity, '恢复启用前的旧组件 runtime'); await verifyTreeIdentity(record.destination, record.quarantineTreeIdentity); }
            else if (await existing(fs, record.destination)) throw new Error('首次安装回滚恢复时检测到 replacement runtime');
            if (record.previousInstalled) setComponentEnabled(record.componentId, record.previousEnabled); else clearComponentEnabledState(record.componentId);
            await removeJournal(record); results.push({ kind: 'install', componentId: record.componentId, operationId: record.operationId, status: 'rolled-back' });
          } else if (record.phase === 'host-committing') {
            await verifyReceipt(record, 'destination', 'destinationIdentity', 'destinationTreeIdentity', '待提交的新组件 runtime');
            await recoverInstallHostState(record.componentId, record.destination, record.desiredEnabled);
            const committed = await persist({ ...record, phase: 'committed' });
            results.push(await cleanupCommittedInstall(committed));
          } else results.push(record.phase === 'committed' ? await cleanupCommittedInstall(record) : await restoreInstall(record));
        } else {
          if (record.phase === 'rolled-back') {
            await verifyFinalizedCleanupProofs(record);
            await verifyReceipt(record, 'sourcePath', 'sourceIdentity', 'sourceTreeIdentity', '恢复取消卸载的组件 runtime');
            if (await existing(fs, record.quarantinePath)) throw new Error('恢复取消卸载时 quarantine 被未知对象占用');
            setComponentEnabled(record.componentId, record.previousEnabled); await removeJournal(record);
            results.push({ kind: 'uninstall', componentId: record.componentId, operationId: record.operationId, status: 'rolled-back' });
          } else if (record.phase === 'finalized') {
            await verifyFinalizedCleanupProofs(record);
            if (await existing(fs, record.sourcePath) || record.destination !== record.sourcePath && await existing(fs, record.destination)) throw new Error('组件卸载终态恢复检测到 replacement runtime');
            clearComponentEnabledState(record.componentId); await removeJournal(record);
            results.push({ kind: 'uninstall', componentId: record.componentId, operationId: record.operationId, status: 'committed', clearUserData: record.clearUserData, cleanupSteps: record.cleanupSteps.map(step => step.name) });
          } else { const quarantinedRecord = await ensureUninstallQuarantined(record); results.push(await finishUninstall(quarantinedRecord)); }
        }
      } catch (error) {
        if (COMPONENT_ID.test(hintedId) && entry.isDirectory() && !entry.isSymbolicLink()) onBlocked(hintedId, error);
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
  const hasPendingJournal = async componentId => {
    const id = String(componentId || ''); if (!COMPONENT_ID.test(id)) throw new Error('组件 ID 无效');
    await ensureRoots(); const stat = await existing(fs, fileFor(id)); if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) { const error = new Error('组件事务固定 journal 路径不是安全目录'); onCorrupt(error); throw error; }
    return true;
  };
  return { active, hasPendingJournal, install, uninstall, recover, journalRoot, validateJournal };
};

module.exports = { MAX_TRANSACTION_JOURNAL_BYTES, MAX_TRANSACTION_STATE_BYTES, SCHEMA_VERSION, assertManagedPath, atomicJson, createComponentTransactionService, nodeIdentity, validateJournal };
