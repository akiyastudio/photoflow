const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { terminateAndWait } = require('../infrastructure/process-termination.cjs');
let sequence = 0;
const publicationBatchTimeoutMs = itemCount => Math.min(10 * 60 * 1000, Math.max(120000, Number(itemCount) * 2000));
const runPublicationJson = (command, args, timeoutMs, processSupervisor, options = {}) => new Promise((resolve, reject) => {
  const spawnImpl = options.spawnImpl || spawn;
  const child = processSupervisor ? processSupervisor.launch({ id: `csharp:file-publication:${++sequence}`, kind: 'csharp-helper', command, args, options: { stdio: ['ignore', 'pipe', 'pipe'] }, ephemeral: true }).child : spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let settled = false; let terminating = false;
  const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-1024 * 1024); }); child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.on('error', error => { if (!terminating) finish(error); }); child.on('close', code => { if (terminating) return; const line = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).pop(); let payload; try { payload = line ? JSON.parse(line) : null; } catch {} if (!payload) return finish(new Error(stderr.trim() || `文件发布服务未返回有效 JSON（代码 ${code}）`)); if (!payload.success) return finish(Object.assign(new Error(payload.error || '文件发布服务失败'), { code: payload.code || 'FILE_PUBLICATION_FAILED', nativeError: payload.nativeError, recoveryPath: payload.recoveryPath, recoveryPathBase64: payload.recoveryPathBase64 })); finish(null, payload); });
  const timer = setTimeout(() => { if (settled || terminating) return; terminating = true; const timeoutError = Object.assign(new Error('文件发布服务响应超时'), { code: 'FILE_PUBLICATION_TIMEOUT' }); void terminateAndWait(child, Date.now() + (options.terminationTimeoutMs || 5000)).then(() => finish(timeoutError), finish); }, timeoutMs);
});
const digest = async filePath => { const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(filePath); for await (const chunk of stream) hash.update(chunk); return hash.digest('hex'); };
const createFilePublicationService = ({ app, projectRoot, processSupervisor = null, platform = process.platform, invokeOverride = null, spawnImpl = null, batchTimeoutMs = publicationBatchTimeoutMs }) => {
  const MAX_BATCH_ITEMS = 2048;
  const MAX_BATCH_MANIFEST_BYTES = 512 * 1024;
  const binaryName = platform === 'win32' ? 'file-publication-service.exe' : 'file-publication-service';
  const executable = () => app.isPackaged ? path.join(process.resourcesPath, binaryName) : path.join(projectRoot, 'electron', 'bin', binaryName);
  const ensure = () => { if (!fs.existsSync(executable())) { const error = new Error(`${platform === 'win32' ? 'Windows' : 'POSIX'} 原子文件发布服务不可用`); error.code = 'FILE_PUBLICATION_SERVICE_MISSING'; throw error; } };
  const decodeSingleRecoveryPath = (encoded, original) => {
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Object.assign(new Error('文件发布服务返回了无效的恢复路径编码'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.includes(0)) throw Object.assign(new Error('文件发布服务返回了无效的恢复路径编码'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw Object.assign(new Error('文件发布服务返回了无效的恢复路径编码'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    const recoveryPath = path.resolve(decoded);
    const expected = path.resolve(original);
    if (path.dirname(recoveryPath) !== path.dirname(expected) || !path.basename(recoveryPath).startsWith(`${path.basename(expected)}.photoflow-recovery-`)) throw Object.assign(new Error('文件发布服务返回了越界恢复路径'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    return recoveryPath;
  };
  const invoke = async (operation, values, timeout = 120000) => {
    try {
      if (invokeOverride) return await invokeOverride(operation, values);
      ensure();
      const args = [operation]; for (const [key, value] of Object.entries(values)) args.push(`--${key}`, String(value));
      return await runPublicationJson(executable(), args, timeout, processSupervisor, spawnImpl ? { spawnImpl } : {});
    } catch (error) {
      error.operation = operation;
      if (error.recoveryPathBase64) {
        const original = operation === 'compare-delete-file' ? values.target : operation === 'commit-cross-volume-file' ? values.source : null;
        if (!original) throw Object.assign(new Error('文件发布服务在不支持的操作中返回了恢复路径'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', operation });
        error.recoveryPath = decodeSingleRecoveryPath(error.recoveryPathBase64, original);
      }
      throw error;
    }
  };
  const moveNoReplace = (source, target) => invoke('move-no-replace', { source: path.resolve(source), target: path.resolve(target) });
  const moveNoReplaceBatch = async requests => {
    if (!Array.isArray(requests) || requests.length === 0) return [];
    if (requests.length > MAX_BATCH_ITEMS) throw Object.assign(new Error(`单次批量发布不得超过 ${MAX_BATCH_ITEMS} 项`), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-publication-${process.pid}-${crypto.randomUUID()}.batch`);
    const contents = requests.map((request, index) => {
      const source = path.resolve(request.source);
      const target = path.resolve(request.target);
      if (typeof request.identity !== 'string' || !request.identity) throw Object.assign(new Error('批量发布缺少预捕获源身份'), { code: 'EINVAL' });
      return `${index}\t${Buffer.from(source, 'utf8').toString('base64')}\t${Buffer.from(target, 'utf8').toString('base64')}\t${Buffer.from(request.identity, 'utf8').toString('base64')}`;
    }).join('\n');
    if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('批量发布清单过大'), { code: 'EINVAL' });
    let handle;
    try {
      handle = await fs.promises.open(manifest, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      const payload = await invoke('move-no-replace-batch', { manifest }, batchTimeoutMs(requests.length));
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const completed = [];
      for (const item of results) {
        const index = Number(item?.index);
        if (!Number.isInteger(index) || index < 0 || index >= requests.length || index !== completed.length) throw Object.assign(new Error('批量文件发布服务返回了无效的结果索引'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed });
        if (!item.success) throw Object.assign(new Error(item.error || '批量文件发布失败'), { code: item.code || 'FILE_PUBLICATION_FAILED', nativeError: item.nativeError, failedIndex: index, completed });
        if (typeof item.identity !== 'string' || !item.identity) throw Object.assign(new Error('批量文件发布服务未返回已发布对象身份'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed });
        completed.push({ index, strategy: item.strategy || 'native-batch-move-no-replace', identity: item.identity });
      }
      if (completed.length !== requests.length) throw Object.assign(new Error('批量文件发布服务返回了不完整的结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed });
      return completed;
    } catch (error) {
      if (!Array.isArray(error.completed)) error.completed = [];
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(manifest, { force: true }).catch(() => undefined);
    }
  };
  const inspectPathsBatch = async paths => {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    if (paths.length > MAX_BATCH_ITEMS * 2) throw Object.assign(new Error(`单次批量检查不得超过 ${MAX_BATCH_ITEMS * 2} 项`), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-inspection-${process.pid}-${crypto.randomUUID()}.batch`);
    const contents = paths.map((candidate, index) => `${index}\t${Buffer.from(path.resolve(candidate), 'utf8').toString('base64')}`).join('\n');
    if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('批量检查清单过大'), { code: 'EINVAL' });
    let handle;
    try {
      handle = await fs.promises.open(manifest, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      const payload = await invoke('inspect-path-batch', { manifest });
      const results = Array.isArray(payload?.results) ? payload.results : [];
      if (results.length !== paths.length || results.some((item, index) => Number(item?.index) !== index)) throw Object.assign(new Error('批量身份检查服务返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
      return results;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(manifest, { force: true }).catch(() => undefined);
    }
  };
  const deletePathsBatch = async requests => {
    if (!Array.isArray(requests) || requests.length === 0) return [];
    if (requests.length > MAX_BATCH_ITEMS) throw Object.assign(new Error(`单次安全清理不得超过 ${MAX_BATCH_ITEMS} 项`), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-cleanup-${process.pid}-${crypto.randomUUID()}.batch`);
    const contents = requests.map((request, index) => `${index}\t${Buffer.from(path.resolve(request.path), 'utf8').toString('base64')}\t${Buffer.from(request.identity, 'utf8').toString('base64')}`).join('\n');
    if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('批量清理清单过大'), { code: 'EINVAL' });
    let handle;
    try {
      handle = await fs.promises.open(manifest, 'wx', 0o600); await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      const payload = await invoke('delete-paths-batch', { manifest });
      const results = Array.isArray(payload?.results) ? payload.results : [];
      if (results.length !== requests.length || results.some((item, index) => Number(item?.index) !== index)) throw Object.assign(new Error('批量安全清理服务返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
      for (let index = 0; index < results.length; index += 1) {
        const encoded = results[index]?.recoveryPathBase64;
        if (!encoded) continue;
        const recoveryPath = path.resolve(Buffer.from(encoded, 'base64').toString('utf8'));
        const original = path.resolve(requests[index].path);
        const expectedPrefix = `${path.basename(original)}.photoflow-quarantine-`;
        if (path.dirname(recoveryPath) !== path.dirname(original) || !path.basename(recoveryPath).startsWith(expectedPrefix)) throw Object.assign(new Error('批量安全清理服务返回了越界恢复路径'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
        results[index].recoveryPath = recoveryPath;
      }
      return results;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(manifest, { force: true }).catch(() => undefined);
    }
  };
  const quarantine = candidate => path.join(path.dirname(candidate), `.${path.basename(candidate)}.photoflow-recovery-${crypto.randomUUID()}`);
  const inspectPortable = async targetPath => { const stat = await fs.promises.lstat(targetPath); return { success: true, identity: `${stat.dev}:${stat.ino}`, directory: stat.isDirectory() }; };
  const restoreQuarantine = async (recovery, original) => { if (fs.existsSync(recovery) && !fs.existsSync(original)) await moveNoReplace(recovery, original); };
  const assertPortableIdentity = (stat, identity, label) => { if (!identity || `${stat.dev}:${stat.ino}` !== identity) throw Object.assign(new Error(`${label}身份已变化`), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); };
  const portableCompareDelete = async ({ target, sha256, size, identity }) => { const resolved = path.resolve(target); const recovery = quarantine(resolved); await moveNoReplace(resolved, recovery); try { const stat = await fs.promises.stat(recovery); assertPortableIdentity(stat, identity, '补偿目标'); if (!stat.isFile() || stat.size !== Number(size) || await digest(recovery) !== sha256) throw Object.assign(new Error('补偿目标身份或摘要不匹配'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); await fs.promises.unlink(recovery); return { success: true, deleted: true }; } catch (error) { await restoreQuarantine(recovery, resolved).catch(() => undefined); error.recoveryPath = fs.existsSync(recovery) ? recovery : undefined; throw error; } };
  const portableCommitTreeFile = async ({ source, target, sha256, size, identity }) => { const resolved = path.resolve(source); const recovery = quarantine(resolved); await moveNoReplace(resolved, recovery); try { const [sourceStat, targetStat, sourceHash, targetHash] = await Promise.all([fs.promises.stat(recovery), fs.promises.stat(target), digest(recovery), digest(target)]); if (`${sourceStat.dev}:${sourceStat.ino}` !== identity || sourceStat.size !== Number(size) || targetStat.size !== Number(size) || sourceHash !== sha256 || targetHash !== sha256) throw Object.assign(new Error('跨卷文件身份或摘要不匹配'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); await fs.promises.unlink(recovery); return { success: true, deleted: true }; } catch (error) { await restoreQuarantine(recovery, resolved).catch(() => undefined); error.recoveryPath = fs.existsSync(recovery) ? recovery : undefined; throw error; } };
  const portableDeleteDirectory = async ({ source, identity }) => { const resolved = path.resolve(source); const recovery = quarantine(resolved); await moveNoReplace(resolved, recovery); try { const stat = await fs.promises.lstat(recovery); if (`${stat.dev}:${stat.ino}` !== identity || !stat.isDirectory() || (await fs.promises.readdir(recovery)).length) throw Object.assign(new Error('源目录身份变化或不为空'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); await fs.promises.rmdir(recovery); return { success: true, deleted: true }; } catch (error) { await restoreQuarantine(recovery, resolved).catch(() => undefined); error.recoveryPath = fs.existsSync(recovery) ? recovery : undefined; throw error; } };
  return {
    moveNoReplace,
    moveNoReplaceBatch,
    inspectPathsBatch,
    deletePathsBatch,
    commitCrossVolumeFile: async request => {
      return invoke('commit-cross-volume-file', { source: path.resolve(request.source), staged: path.resolve(request.staged), target: path.resolve(request.target), sha256: request.sha256, size: request.size, 'source-identity': request.sourceIdentity }, 30 * 60 * 1000);
    },
    compareDeleteFile: request => invoke('compare-delete-file', { target: path.resolve(request.target), sha256: request.sha256, size: request.size, identity: request.identity }),
    inspectPath: targetPath => invoke('inspect-path', { path: path.resolve(targetPath) }),
    commitTreeFile: request => platform === 'win32' ? invoke('commit-tree-file', { source: path.resolve(request.source), target: path.resolve(request.target), sha256: request.sha256, size: request.size, identity: request.identity }) : portableCommitTreeFile(request),
    deleteEmptyDirectory: request => platform === 'win32' ? invoke('delete-empty-directory', { source: path.resolve(request.source), identity: request.identity }) : portableDeleteDirectory(request),
    nativeAvailable: () => Boolean(invokeOverride) || fs.existsSync(executable()), platform, executable,
  };
};
module.exports = { createFilePublicationService, publicationBatchTimeoutMs, runPublicationJson };
