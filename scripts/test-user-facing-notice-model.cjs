const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '..', 'src', 'features', 'app', 'user-facing-notice-model.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', 'require', compiled)(moduleUnderTest, moduleUnderTest.exports, require);
const { prepareUserFacingNotice, prepareUserFacingUpdate } = moduleUnderTest.exports;

const renameConflict = prepareUserFacingNotice('重命名失败：progress_folder_target_conflict: 目标目录已存在');
assert.strictEqual(renameConflict.message, '重命名失败：这个名称已经存在，请换一个');
assert.strictEqual(renameConflict.options.durationMs, 4000);
assert(!renameConflict.message.includes('progress_folder_target_conflict'));

const invalidName = prepareUserFacingNotice('progress_folder_name_invalid: 目录名称包含 Windows 非法字符');
assert.strictEqual(invalidName.message, '操作失败：这个名称不能使用，请换一个');
assert.strictEqual(invalidName.options.durationMs, 4000);

const staleFolder = prepareUserFacingNotice('重命名失败：progress_folder_identity_mismatch: folderId 已变化，请刷新后重试');
assert.strictEqual(staleFolder.message, '重命名失败：内容已经发生变化，请刷新后重试');
assert.strictEqual(staleFolder.options.durationMs, 5000);

const busy = prepareUserFacingNotice('更新版本失败：node_busy: 节点正在比较');
assert.strictEqual(busy.message, '更新版本失败：当前操作还没结束，请稍后重试');
assert.strictEqual(busy.options.durationMs, 5000);

const systemError = prepareUserFacingNotice("打开文件失败：Error: ENOENT: no such file or directory, open 'C:\\private\\photo.jpg'");
assert.strictEqual(systemError.message, '打开文件失败：文件已经不存在或被移动');
assert.strictEqual(systemError.options.durationMs, 5000);
assert(!systemError.message.includes('C:\\private'));

const unknownEnglish = prepareUserFacingNotice('视频剪辑失败：Error: process exited with code 1');
assert.strictEqual(unknownEnglish.message, '视频剪辑失败：请检查文件后重试');
assert.strictEqual(unknownEnglish.options.durationMs, 5000);

const unknownInternal = prepareUserFacingNotice('选片失败：selection_unexpected_worker_fault: internal detail');
assert.strictEqual(unknownInternal.message, '选片失败：请重试，仍然失败时查看日志');
assert.strictEqual(unknownInternal.options.durationMs, 5000);

const existingDuration = prepareUserFacingNotice('复制文件地址失败', 7000);
assert.strictEqual(existingDuration.options.durationMs, 7000, 'call-site durations must remain authoritative');

const persistent = prepareUserFacingNotice('操作失败：progress_folder_target_conflict: 目标目录已存在', { lifecycle: 'persistent' });
assert.strictEqual(persistent.options.lifecycle, 'persistent');
assert.strictEqual(persistent.options.durationMs, undefined, 'explicit persistence must not be overridden');

const seriousRollback = prepareUserFacingNotice('移动失败：文件夹回滚失败，请打开修复面板');
assert.strictEqual(seriousRollback.options, undefined, 'rollback failures must keep the existing persistent error policy');

const seriousDatabase = prepareUserFacingNotice('数据库损坏，读取项目失败');
assert.strictEqual(seriousDatabase.options, undefined, 'database integrity failures must remain persistent');

const explicitErrorTone = prepareUserFacingNotice('打开失败：ENOENT: missing', 'error');
assert.strictEqual(explicitErrorTone.options.tone, 'error');
assert.strictEqual(explicitErrorTone.options.durationMs, 5000);

const restored = prepareUserFacingNotice('已恢复上次失败的跟踪会话，可检查后重试。');
assert.strictEqual(restored.message, '已恢复上次失败的跟踪会话，可检查后重试。');
assert.strictEqual(restored.options.tone, 'success');

const degraded = prepareUserFacingNotice('已创建 2 个原始素材外链；部分位置无法实时监听，已启用低频补扫。');
assert.strictEqual(degraded.options.tone, 'warning');
assert.strictEqual(degraded.options.durationMs, 5000);

const safeProductName = prepareUserFacingNotice('NAS 连接测试失败，请检查地址和账号', 6000);
assert.strictEqual(safeProductName.message, 'NAS 连接测试失败，请检查地址和账号');
assert.strictEqual(safeProductName.options.durationMs, 6000);

const update = prepareUserFacingUpdate({ message: '读取失败：SQLITE_BUSY: database is locked', tone: 'error' });
assert.strictEqual(update.message, '读取失败：项目数据正在使用中，请稍后重试');
assert.strictEqual(update.tone, 'error');
assert.strictEqual(update.durationMs, 5000);

const consumers = [
  'src/App.tsx',
  'src/components/ProjectNavigator.tsx',
  'src/features/app/DomainHealthBanner.tsx',
  'src/features/components/useComponentPages.ts',
  'src/features/inspiration/InspirationLibrary.tsx',
  'src/features/settings/SettingsFeature.tsx',
  'src/features/workspace/ProjectWorkspace.tsx',
];
for (const relativePath of consumers) {
  const consumer = fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
  assert(consumer.includes('useUserFacingToast'), `${relativePath} must use the user-facing toast boundary`);
  assert(!/import\s*\{[^}]*\buseToast\b[^}]*\}\s*from/.test(consumer), `${relativePath} must not bypass the user-facing toast boundary`);
}

const sourceRoot = path.resolve(__dirname, '..', 'src');
const rendererFiles = [];
const collectRendererFiles = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collectRendererFiles(target);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) rendererFiles.push(target);
  }
};
collectRendererFiles(sourceRoot);
for (const file of rendererFiles) {
  if (file.endsWith(`${path.sep}useTopToastStack.tsx`) || file.endsWith(`${path.sep}useUserFacingToast.ts`)) continue;
  const rendererSource = fs.readFileSync(file, 'utf8');
  assert(!/import\s*\{[^}]*\buseToast\b[^}]*\}\s*from/.test(rendererSource), `${path.relative(sourceRoot, file)} bypasses the user-facing toast boundary`);
}

const backendRoots = ['python', 'electron', 'services', 'extensions'].map(root => path.resolve(__dirname, '..', root));
const backendFiles = [];
const collectBackendFiles = directory => {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collectBackendFiles(target);
    else if (/\.(?:py|cjs|js|ts|tsx)$/.test(entry.name) && !/(?:^|[\\/])(?:test|tests|__tests__)(?:[\\/]|$)/.test(target)) backendFiles.push(target);
  }
};
backendRoots.forEach(collectBackendFiles);
let backendCodeMessages = 0;
const distinctBackendCodes = new Set();
for (const file of backendFiles) {
  const backendSource = fs.readFileSync(file, 'utf8');
  const codeMessage = /["'`]([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\s*[：:][^"'`\r\n]*\p{Script=Han}/gu;
  for (const match of backendSource.matchAll(codeMessage)) {
    backendCodeMessages += 1;
    distinctBackendCodes.add(match[1]);
    const prepared = prepareUserFacingNotice(`操作失败：${match[0].slice(1)}`);
    assert(!prepared.message.includes(match[1]), `${match[1]} must not reach a toast`);
    assert(/\p{Script=Han}/u.test(prepared.message), `${match[1]} must produce a Chinese notice`);
  }
}
assert(backendCodeMessages >= 184, 'the production backend error-code inventory unexpectedly shrank; update the audit expectation if intentional');
assert(distinctBackendCodes.size >= 95, 'the production backend error-code inventory unexpectedly changed');

const coreTonePolicy = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'app', 'top-toast-tone-model.ts'), 'utf8');
assert(coreTonePolicy.includes("durationMs: tone === 'error' ? null : 3500"), 'the existing toast duration policy must stay unchanged');
assert(coreTonePolicy.includes("persistent: tone === 'error'"), 'the existing persistent error policy must stay unchanged');

console.log('user-facing notice model tests passed');
