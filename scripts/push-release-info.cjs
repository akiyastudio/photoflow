const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const releaseConfig = require('./release-config.cjs');
const { hashStableArtifact } = require('./verify-component-packages.cjs');
const {
  hiddenQuestion,
  persistWindowsUserToken,
  publishReleaseOnce,
  readWindowsUserToken,
  validateAdminToken,
} = require('./publish-release.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const installerRoot = path.join(repositoryRoot, 'artifacts', 'installers');

const parseArguments = values => {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`无法识别参数：${value}`);
    const [key, inlineValue] = value.slice(2).split(/=(.*)/s);
    const next = inlineValue === undefined ? values[++index] : inlineValue;
    if (next === undefined || String(next).trim() === '') throw new Error(`参数 --${key} 缺少值`);
    result[key] = String(next).trim();
  }
  return result;
};

const parseMandatory = value => {
  if (value === undefined) return false;
  if (/^(?:1|true|yes|y|是)$/i.test(value)) return true;
  if (/^(?:0|false|no|n|否)$/i.test(value)) return false;
  throw new Error('--mandatory 只接受 true/false 或 y/n');
};

const findInstaller = (version, explicitPath = '') => {
  if (explicitPath) {
    const selected = path.resolve(explicitPath);
    if (!fs.statSync(selected, { throwIfNoEntry: false })?.isFile()) throw new Error(`安装包不存在：${selected}`);
    return selected;
  }
  if (!fs.existsSync(installerRoot)) throw new Error(`安装包目录不存在：${installerRoot}`);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`Setup\\s+${escaped}\\.exe$`, 'i');
  const matches = fs.readdirSync(installerRoot)
    .filter(name => exact.test(name))
    .map(name => path.join(installerRoot, name));
  if (matches.length !== 1) throw new Error(`需要且只能有一个版本 ${version} 的 Setup EXE，实际找到 ${matches.length} 个`);
  return matches[0];
};

const idempotencyKeyFor = record => crypto.createHash('sha256').update(JSON.stringify({
  channel: record.channel,
  downloadUrl: record.downloadUrl,
  mandatory: record.mandatory,
  notes: record.notes,
  platform: record.platform,
  sha256: record.sha256,
  version: record.version,
  versionCode: record.versionCode,
})).digest('hex');

const run = async () => {
  const args = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  const parts = version.split('.').map(Number);
  if (!/^\d+\.\d+\.\d+$/.test(version) || parts.some(value => !Number.isSafeInteger(value) || value < 0) || parts[1] > 99 || parts[2] > 99) {
    throw new Error(`package.json 版本号无效：${version}`);
  }

  const installerPath = findInstaller(version, args.installer);
  const installerDigest = await hashStableArtifact(installerPath);
  const downloadUrl = String(args.url || releaseConfig.downloadUrl || '').trim();
  let parsedDownloadUrl;
  try { parsedDownloadUrl = new URL(downloadUrl); } catch { throw new Error('下载链接格式无效'); }
  if (parsedDownloadUrl.protocol !== 'https:') throw new Error('下载链接必须使用 HTTPS');

  let token = String(process.env.PHOTOFLOW_ADMIN_TOKEN || '').trim() || readWindowsUserToken();
  let persistToken = false;
  if (!token) {
    token = await hiddenQuestion('未配置 PHOTOFLOW_ADMIN_TOKEN，请粘贴 CloudBase 管理 Token：');
    persistToken = true;
  }
  token = validateAdminToken(token);

  const record = {
    channel: 'stable',
    downloadUrl,
    mandatory: parseMandatory(args.mandatory),
    notes: String(args.notes || '修复了若干问题并提升稳定性。').slice(0, 4000),
    platform: 'win32',
    published: true,
    publishedAt: new Date().toISOString(),
    sha256: installerDigest.sha256,
    version,
    versionCode: parts[0] * 10_000 + parts[1] * 100 + parts[2],
  };

  const apiBaseUrl = String(releaseConfig.apiBaseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(apiBaseUrl)) throw new Error('electron/cloud-config.cjs 中缺少有效的 HTTPS apiBaseUrl');
  await publishReleaseOnce({
    url: `${apiBaseUrl}/v1/admin/releases`,
    token,
    record,
    idempotencyKey: idempotencyKeyFor(record),
  });
  if (persistToken && persistWindowsUserToken(token)) console.log('管理员 Token 已保存到 Windows 用户环境变量。');

  console.log(`\n版本 ${version} 的发布信息已推送。`);
  console.log(`安装包：${installerPath}`);
  console.log(`SHA-256：${installerDigest.sha256}`);
  console.log(`下载地址：${downloadUrl}`);
};

if (require.main === module) run().catch(error => {
  console.error(`\n发布信息推送失败：${error.message || error}`);
  process.exitCode = 1;
});

module.exports = { findInstaller, idempotencyKeyFor, parseArguments, parseMandatory };
