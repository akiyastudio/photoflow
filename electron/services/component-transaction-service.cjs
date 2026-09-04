const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TOKEN = /^[a-zA-Z0-9._-]{1,180}$/;
const SCHEMA_VERSION = 1;
const INSTALL_PHASES = new Set(['prepared', 'backup-moved', 'published', 'host-committing', 'committed', 'blocked']);
const UNINSTALL_PHASES = new Set(['prepared', 'quarantined', 'cleanup-pending', 'committed', 'blocked']);
const CLEANUP_STATES = new Set(['pending', 'executing', 'applied']);

const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const nodeIdentity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const sameNode = (left, right) => left && right && left.dev === right.dev
  && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
const validNode = value => value === null || exact(value, ['dev', 'ino', 'birthtimeMs'])
  && ['dev', 'ino', 'birthtimeMs'].every(key => Number.isFinite(value[key]));
const validPath = value => typeof value === 'string' && value.length <= 32767 && !value.includes('\0');
const validTree = value => Array.isArray(value) && value.length <= 20000 && value.every(entry => {
  if (!plain(entry) || typeof entry.path !== 'string' || !entry.path || entry.path.length > 1024 || entry.path.includes('\0') || entry.path.includes(':')) return false;
  if (entry.kind === 'directory') return exact(entry, ['path', 'kind']);
  return entry.kind === 'file' && exact(entry, ['path', 'kind', 'size', 'sha256']) && Number.isSafeInteger(entry.size) && entry.size >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256);
});
const validCleanup = value => Array.isArray(value) && value.length <= 10000
  && value.every(step => exact(step, ['name', 'state']) && TOKEN.test(step.name) && CLEANUP_STATES.has(step.state));

const validateJournal = value => {
  const keys = ['schemaVersion', 'kind', 'operationId', 'generation', 'componentId', 'phase', 'installRoot', 'installRootIdentity', 'container', 'destination', 'sourcePath', 'quarantinePath', 'destinationIdentity', 'sourceIdentity', 'quarantineIdentity', 'destinationTreeIdentity', 'sourceTreeIdentity', 'quarantineTreeIdentity', 'previousInstalled', 'previousEnabled', 'desiredEnabled', 'clearUserData', 'cleanupSteps', 'lastError', 'updatedAt'];
  if (!exact(value, keys) || value.schemaVersion !== SCHEMA_VERSION || !['install', 'uninstall'].includes(value.kind) || !TOKEN.test(value.operationId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || !COMPONENT_ID.test(value.componentId)
    || !['installRoot', 'container', 'destination', 'sourcePath', 'quarantinePath'].every(key => validPath(value[key]))
    || !validNode(value.installRootIdentity) || value.installRootIdentity === null || !validNode(value.destinationIdentity) || !validNode(value.sourceIdentity) || !validNode(value.quarantineIdentity)
    || !validTree(value.destinationTreeIdentity) || !validTree(value.sourceTreeIdentity) || !validTree(value.quarantineTreeIdentity)
    || typeof value.previousInstalled !== 'boolean' || typeof value.previousEnabled !== 'boolean' || typeof value.desiredEnabled !== 'boolean' || typeof value.clearUserData !== 'boolean'
    || !validCleanup(value.cleanupSteps) || typeof value.lastError !== 'string' || value.lastError.length > 4000 || !Number.isFinite(value.updatedAt)) throw new Error('组件事务日志 schema 无效');
  if (value.kind === 'install' ? !INSTALL_PHASES.has(value.phase) : !UNINSTALL_PHASES.has(value.phase)) throw new Error('组件事务日志阶段无效');
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
const atomicJson = async ({ fs, path, crypto, filePath, value }) => {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, filePath);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('组件事务日志不是安全的普通文件');
    await syncDirectory(fs, directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
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

const createComponentTransactionService = ({ fs, path, crypto, installRoot, captureTreeIdentity, verifyTreeIdentity, getComponentEnabled = () => true, setComponentEnabled = () => undefined, clearComponentEnabledState = () => undefined, recoverInstallHostState = async () => undefined, cleanupProvider = () => [], onBlocked = () => undefined, onUnblocked = () => undefined, onCorrupt = () => undefined, now = Date.now, fault = async () => undefined }) => {
  const root = path.resolve(installRoot);
  const journalRoot = path.join(root, '.transactions');
  const active = new Map();
  const recoveries = new Map();
  let installRootIdentity = null;
  let journalRootIdentity = null;
  const fileFor = componentId => path.join(journalRoot, `${componentId}.json`);
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
    await atomicJson({ fs, path, crypto, filePath: fileFor(next.componentId), value: next });
    return next;
  };
  const removeJournal = async record => {
    await ensureRoots();
    await fs.promises.rm(fileFor(record.componentId), { force: true });
    await syncDirectory(fs, journalRoot);
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
  const verifyTreeSubset = async (target, expected, label) => {
    const expectedByPath = new Map(expected.map(entry => [entry.path, JSON.stringify(entry)]));
    const remaining = await captureTreeIdentity(target);
    if (remaining.some(entry => expectedByPath.get(entry.path) !== JSON.stringify(entry))) throw new Error(`${label}包含不属于原始收据的节点`);
  };
  const detachAndRemove = async (record, pathField, identityField, treeField, label) => {
    const target = record[pathField];
    if (!target) return;
    const detached = path.join(root, `.${record.componentId}-${record.operationId}-${pathField}-cleanup`);
    const targetStat = await existing(fs, target);
    const detachedStat = await existing(fs, detached);
    if (targetStat && detachedStat) throw new Error(`${label}与 cleanup quarantine 同时存在`);
    if (!targetStat && !detachedStat) return;
    if (targetStat) {
      await verifyReceipt(record, pathField, identityField, treeField, label);
      await fs.promises.rename(target, detached);
      try {
        await assertReceipt(detached, record[identityField], `${label} cleanup quarantine`);
        await verifyTreeIdentity(detached, record[treeField]);
      } catch (error) {
        if (!(await existing(fs, target))) await fs.promises.rename(detached, target).catch(() => undefined);
        throw error;
      }
    } else {
      await assertManagedPath({ fs, path, root, target: detached, label: `${label} cleanup quarantine` });
      await assertReceipt(detached, record[identityField], `${label} cleanup quarantine`);
      await verifyTreeSubset(detached, record[treeField], `${label} cleanup quarantine`);
    }
    await fault(`cleanup:remove:${pathField}`, { ...record, detached });
    await fs.promises.rm(detached, { recursive: true, force: false });
  };
  const base = ({ kind, componentId, container, destination, sourcePath = '', quarantinePath = '', destinationIdentity = null, sourceIdentity = null, quarantineIdentity = null, destinationTreeIdentity = [], sourceTreeIdentity = [], quarantineTreeIdentity = [], previousInstalled = true, previousEnabled, desiredEnabled, clearUserData = false, cleanupSteps = [] }) => validateJournal({
    schemaVersion: SCHEMA_VERSION, kind, operationId: crypto.randomUUID(), generation: 1, componentId, phase: 'prepared', installRoot: root, installRootIdentity, container: path.resolve(container), destination: path.resolve(destination), sourcePath: sourcePath ? path.resolve(sourcePath) : '', quarantinePath: quarantinePath ? path.resolve(quarantinePath) : '', destinationIdentity, sourceIdentity, quarantineIdentity, destinationTreeIdentity, sourceTreeIdentity, quarantineTreeIdentity, previousInstalled, previousEnabled, desiredEnabled, clearUserData, cleanupSteps, lastError: '', updatedAt: now(),
  });
  const block = async (record, error, phase = 'blocked') => {
    onBlocked(record.componentId, error);
    try {
      return await persist({ ...record, phase, lastError: String(error?.message || error).slice(0, 4000) });
    } catch (journalError) {
      throw new AggregateError([error, journalError], '组件事务失败且阻断状态无法持久化');
    }
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
      if (!backupAlreadyRestored && record.destinationIdentity) await detachAndRemove(record, 'destination', 'destinationIdentity', 'destinationTreeIdentity', '待回滚的新组件 runtime');
      if (backupStat) {
        await verifyReceipt(record, 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity', '旧组件 quarantine');
        if (await existing(fs, record.destination)) throw new Error('组件目标被占用，无法恢复旧 runtime');
        await fault('install:restore-backup', record);
        await fs.promises.rename(record.quarantinePath, record.destination);
        await assertReceipt(record.destination, record.quarantineIdentity, '恢复的旧组件 runtime');
        await verifyTreeIdentity(record.destination, record.quarantineTreeIdentity);
      }
      if (record.sourceIdentity) await detachAndRemove(record, 'sourcePath', 'sourceIdentity', 'sourceTreeIdentity', '组件发布暂存目录');
      if (record.previousInstalled) setComponentEnabled(record.componentId, record.previousEnabled);
      else clearComponentEnabledState(record.componentId);
      await removeJournal(record);
      return { kind: 'install', componentId: record.componentId, operationId: record.operationId, status: 'rolled-back' };
    } catch (error) {
      error.code ||= 'COMPONENT_TRANSACTION_BLOCKED';
      error.journal = await block(record, error);
      throw error;
    }
  };
  const cleanupCommittedInstall = async record => {
    try {
      setComponentEnabled(record.componentId, record.desiredEnabled);
      if (record.quarantinePath && record.quarantineIdentity) {
        await fault('install:cleanup-backup', record);
        await detachAndRemove(record, 'quarantinePath', 'quarantineIdentity', 'quarantineTreeIdentity', '已提交组件备份');
      }
      if (record.sourcePath && record.sourceIdentity) await detachAndRemove(record, 'sourcePath', 'sourceIdentity', 'sourceTreeIdentity', '已提交组件暂存目录');
      await removeJournal(record);
      return { kind: 'install', componentId: record.componentId, operationId: record.operationId, status: 'committed' };
    } catch (error) {
      // committed is the forward-only commit point; cleanup failure must never roll back it.
      error.code ||= 'COMPONENT_TRANSACTION_CLEANUP_PENDING';
      error.journal = await block(record, error, 'committed');
      throw error;
    }
  };
  const install = async ({ componentId, container, destination, stagingPath, stagingIdentity, stagingTreeIdentity, previousInstalled = true, previousEnabled = getComponentEnabled(componentId), desiredEnabled = true, validatePublished, commitHostState, onAdmitted = () => undefined }) => {
    if (!COMPONENT_ID.test(componentId)) throw new Error('组件 ID 无效');
    if (active.has(componentId)) throw Object.assign(new Error('组件事务正在进行'), { code: 'COMPONENT_LIFECYCLE_BUSY' });
    active.set(componentId, 'install');
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

      const quarantinePath = path.join(root, `.${componentId}-quarantine-${crypto.randomUUID()}`);
      record = await persist({
        ...base({
          kind: 'install', componentId, container, destination, sourcePath: stagingPath, quarantinePath,
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
      });
      await verifyReceipt(record, 'destination', 'destinationIdentity', 'destinationTreeIdentity', '新组件 runtime');
      await validatePublished(destination);

      // host-committing is replayed forward after a crash; pre-commit phases roll back.
      record = await persist({ ...record, phase: 'host-committing' });
      await commitHostState(destination, desiredEnabled);
      setComponentEnabled(componentId, desiredEnabled);
      hostCommitted = true;
      record = await persist({ ...record, phase: 'committed' });
      await cleanupCommittedInstall(record);
      return { operationId: record.operationId, status: 'committed' };
    } catch (error) {
      if (error?.simulateCrash === true) throw error;
      if (hostCommitted && record) {
        try {
          record = await persist({ ...record, phase: 'committed' });
          await cleanupCommittedInstall(record);
          return { operationId: record.operationId, status: 'committed' };
        } catch (forwardError) {
          forwardError.code ||= 'COMPONENT_TRANSACTION_BLOCKED';
          forwardError.journal = await block(record, forwardError, 'host-committing');
          throw forwardError;
        }
      }
      if (record && (publicationStarted || record.phase !== 'prepared' || !(await existing(fs, stagingPath)))) await restoreInstall(record);
      else if (record) await removeJournal(record).catch(() => undefined);
      throw error;
    }
    finally {
      active.delete(componentId);
    }
  };
  const advanceCleanup = async original => {
    let record = original;
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
      clearComponentEnabledState(current.componentId);
      current = await persist({ ...current, phase: 'committed' });
      await removeJournal(current);
      return { kind: 'uninstall', componentId: current.componentId, operationId: current.operationId, status: 'committed', clearUserData: current.clearUserData, cleanupSteps: current.cleanupSteps.map(step => step.name) };
    } catch (error) {
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
      const runtimeTrash = record.cleanupSteps.find(step => step.name === 'runtime-trash');
      if (!runtimeTrash || runtimeTrash.state === 'pending') throw new Error('卸载源与 quarantine 均不存在，无法安全恢复');
    }
    return record;
  };
  const uninstall = async ({ componentId, container, destination, targetPath, targetIdentity, targetTreeIdentity, clearUserData, previousEnabled = getComponentEnabled(componentId) }) => {
    if (!COMPONENT_ID.test(componentId)) throw new Error('组件 ID 无效');
    if (active.has(componentId)) throw Object.assign(new Error('组件事务正在进行'), { code: 'COMPONENT_LIFECYCLE_BUSY' });
    active.set(componentId, 'uninstall');
    let record;
    let quarantined = false;
    try {
      await ensureRoots();
      await assertManagedPath({ fs, path, root, target: targetPath, label: '卸载目标' });
      await assertReceipt(targetPath, targetIdentity, '卸载目标');
      await verifyTreeIdentity(targetPath, targetTreeIdentity);
      const steps = cleanupProvider(componentId, clearUserData).map(step => ({ name: step.name, state: 'pending' }));
      if (!steps.some(step => step.name === 'runtime-trash')) throw new Error('组件 runtime 回收步骤缺失');
      record = await persist({
        ...base({
          kind: 'uninstall', componentId, container, destination, sourcePath: targetPath,
          quarantinePath: path.join(root, `.${componentId}-uninstall-${crypto.randomUUID()}`),
          sourceIdentity: targetIdentity, sourceTreeIdentity: targetTreeIdentity,
          previousEnabled, desiredEnabled: false, clearUserData, cleanupSteps: steps,
        }),
        generation: 0,
      });
      // Once quarantined, runtime remains persistently disabled until every cleanup receipt is applied.
      record = await ensureUninstallQuarantined(record);
      quarantined = true;
      return await finishUninstall(record);
    }
    catch (error) {
      if (error?.simulateCrash === true) throw error;
      if (!quarantined && record && await existing(fs, record.sourcePath)) {
        setComponentEnabled(componentId, previousEnabled);
        await removeJournal(record).catch(() => undefined);
      }
      else if (record && !error.journal) error.journal = await block(record, error, 'cleanup-pending');
      throw error;
    }
    finally {
      active.delete(componentId);
    }
  };
  const recoverOnce = async (componentIdFilter = '') => {
    await ensureRoots();
    const entries = await fs.promises.readdir(journalRoot, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      const hintedId = entry.name.slice(0, -5);
      if (componentIdFilter && hintedId !== componentIdFilter) continue;
      try {
        const record = validateJournal(JSON.parse(await fs.promises.readFile(path.join(journalRoot, entry.name), 'utf8')));
        if (record.installRoot !== root || !sameNode(record.installRootIdentity, installRootIdentity) || entry.name !== `${record.componentId}.json`) throw new Error('组件事务日志归属无效');
        for (const target of [record.container, record.destination, record.sourcePath, record.quarantinePath].filter(Boolean)) {
          await assertManagedPath({ fs, path, root, target, allowMissing: true, label: '事务路径' });
        }
        onBlocked(record.componentId, new Error('组件事务正在恢复'));
        if (record.kind === 'install') {
          if (record.phase === 'host-committing') {
            await verifyReceipt(record, 'destination', 'destinationIdentity', 'destinationTreeIdentity', '待提交的新组件 runtime');
            await recoverInstallHostState(record.componentId, record.destination, record.desiredEnabled);
            setComponentEnabled(record.componentId, record.desiredEnabled);
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
  const recover = (componentIdFilter = '') => {
    if (componentIdFilter && active.has(componentIdFilter)) {
      return Promise.reject(Object.assign(new Error('组件事务正在进行，不能并发恢复'), { code: 'COMPONENT_LIFECYCLE_BUSY' }));
    }
    const key = componentIdFilter || '*';
    const existingRecovery = recoveries.get(key);
    if (existingRecovery) return existingRecovery;
    const operation = recoverOnce(componentIdFilter);
    recoveries.set(key, operation);
    return operation.finally(() => {
      if (recoveries.get(key) === operation) recoveries.delete(key);
    });
  };
  return { active, install, uninstall, recover, journalRoot, validateJournal };
};

module.exports = { SCHEMA_VERSION, assertManagedPath, atomicJson, createComponentTransactionService, nodeIdentity, validateJournal };
