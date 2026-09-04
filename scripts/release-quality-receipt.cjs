const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCHEMA_VERSION = 1;
const TOOL_VERSION = 1;
const COMMAND = 'npm run check:release:quality';
const receiptPathFor = repositoryRoot => path.join(repositoryRoot, 'artifacts', 'release-quality-receipt.json');
const identityFor = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameIdentity = (left, right) => left && right && Object.keys(left).every(key => left[key] === right[key]);

const atomicWriteJson = (target, value) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
};

const writeQualityReceipt = ({ repositoryRoot, gitCommit, startedAt, finishedAt }) => {
  const receipt = { schemaVersion: SCHEMA_VERSION, toolVersion: TOOL_VERSION, command: COMMAND, status: 'passed', gitCommit, startedAt, finishedAt };
  atomicWriteJson(receiptPathFor(repositoryRoot), receipt);
  return receipt;
};
const validateQualityReceipt = ({ repositoryRoot, gitCommit }) => {
  const receiptPath = receiptPathFor(repositoryRoot);
  let fd;
  try { fd = fs.openSync(receiptPath, 'r'); }
  catch (error) { if (error?.code === 'ENOENT') throw new Error('发布质量门禁回执缺失或过大；请重新运行 release:prepare'); throw error; }
  let identity;
  let receipt;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024) throw new Error('发布质量门禁回执缺失或过大；请重新运行 release:prepare');
    identity = identityFor(stat);
    receipt = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const pathStat = fs.statSync(receiptPath, { throwIfNoEntry: false });
    if (!sameIdentity(identity, identityFor(fs.fstatSync(fd))) || !pathStat || !sameIdentity(identity, identityFor(pathStat))) throw new Error('发布质量门禁回执在读取期间被替换');
  } finally { fs.closeSync(fd); }
  const keys = ['schemaVersion', 'toolVersion', 'command', 'status', 'gitCommit', 'startedAt', 'finishedAt'];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).sort().join('\0') !== keys.sort().join('\0')
    || receipt.schemaVersion !== SCHEMA_VERSION || receipt.toolVersion !== TOOL_VERSION || receipt.command !== COMMAND || receipt.status !== 'passed'
    || receipt.gitCommit !== gitCommit || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.finishedAt))
    || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) throw new Error('发布质量门禁回执无效或不对应当前 HEAD；请重新运行 release:prepare');
  Object.defineProperties(receipt, { sourceIdentity: { value: identity }, sourcePath: { value: receiptPath } });
  return receipt;
};
const assertCleanGitWorktree = repositoryRoot => {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  if (status.error || status.status !== 0) throw new Error('无法验证发布工作树状态');
  if (String(status.stdout || '').trim()) throw new Error('发布工作树包含未提交或未跟踪改动；质量回执不能绑定到不同的构建输入');
  return { status: 'clean' };
};

module.exports = { COMMAND, atomicWriteJson, receiptPathFor, writeQualityReceipt, validateQualityReceipt, assertCleanGitWorktree };
