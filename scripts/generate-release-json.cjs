const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const repositoryRoot = path.resolve(__dirname, '..');
const releaseRoot = path.join(repositoryRoot, 'artifacts', 'installers');
const outputRoot = path.join(repositoryRoot, 'artifacts', 'cloudbase');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));

const parseArguments = values => {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const [rawKey, inlineValue] = value.slice(2).split(/=(.*)/s);
    result[rawKey] = inlineValue === undefined ? values[++index] : inlineValue;
  }
  return result;
};

const booleanValue = (value, fallback) => {
  if (value === undefined || String(value).trim() === '') return fallback;
  if (/^(?:1|true|yes|y|是)$/i.test(String(value).trim())) return true;
  if (/^(?:0|false|no|n|否)$/i.test(String(value).trim())) return false;
  throw new Error(`无法识别布尔值：${value}`);
};

const sha256File = filePath => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('error', reject);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
});

const findInstaller = version => {
  if (!fs.existsSync(releaseRoot)) throw new Error(`安装包目录不存在：${releaseRoot}`);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`Setup\\s+${escapedVersion}\\.exe$`, 'i');
  const fallback = new RegExp(`(?:^|[^0-9])${escapedVersion}(?:[^0-9]|$)`, 'i');
  const candidates = fs.readdirSync(releaseRoot)
    .filter(name => name.toLowerCase().endsWith('.exe'))
    .filter(name => exact.test(name) || fallback.test(name))
    .map(name => ({ path: path.join(releaseRoot, name), exact: exact.test(name), mtimeMs: fs.statSync(path.join(releaseRoot, name)).mtimeMs }))
    .sort((left, right) => Number(right.exact) - Number(left.exact) || right.mtimeMs - left.mtimeMs);
  if (!candidates.length) throw new Error(`没有找到版本 ${version} 的 EXE 安装包，请先执行 npm run electron:build`);
  return candidates[0].path;
};

const findPreviousDownloadUrl = () => {
  if (!fs.existsSync(outputRoot)) return '';
  const candidates = fs.readdirSync(outputRoot)
    .filter(name => /^app-release-.*\.json$/i.test(name))
    .map(name => {
      const filePath = path.join(outputRoot, name);
      try {
        const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const downloadUrl = String(record.downloadUrl || '').trim();
        if (new URL(downloadUrl).protocol !== 'https:') return undefined;
        return { downloadUrl, publishedAt: Date.parse(record.publishedAt) || fs.statSync(filePath).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.publishedAt - left.publishedAt);
  return candidates[0]?.downloadUrl || '';
};

const run = async () => {
  const args = parseArguments(process.argv.slice(2));
  const version = String(args.version || packageJson.version || '').trim();
  const versionParts = version.split('.').map(Number);
  if (!/^\d+\.\d+\.\d+$/.test(version) || versionParts.some(value => !Number.isSafeInteger(value)) || versionParts[1] > 99 || versionParts[2] > 99) {
    throw new Error(`package.json 中的版本号无效：${version}`);
  }

  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    const installerPath = path.resolve(args.installer || findInstaller(version));
    if (!fs.statSync(installerPath).isFile()) throw new Error(`安装包不存在：${installerPath}`);
    const downloadUrl = String(args.url || findPreviousDownloadUrl()).trim();
    if (!downloadUrl) throw new Error('没有找到可沿用的 HTTPS 下载链接；请首次运行时使用 --url 指定');
    let parsedUrl;
    try { parsedUrl = new URL(downloadUrl); } catch { throw new Error('下载链接格式无效'); }
    if (parsedUrl.protocol !== 'https:') throw new Error('下载链接必须使用 HTTPS');

    let notes = String(args.notes || '').trim();
    if (!notes) notes = (await terminal.question('请输入更新说明：')).trim();
    if (!notes) notes = '修复了若干问题并提升稳定性。';
    if (notes.length > 4000) throw new Error('更新说明不能超过 4000 个字符');

    const interactiveMandatory = args.mandatory === undefined
      ? await terminal.question('是否强制更新？[y/N]：')
      : args.mandatory;
    const mandatory = booleanValue(interactiveMandatory, false);
    const published = booleanValue(args.published, true);
    const sha256 = await sha256File(installerPath);
    const versionCode = versionParts[0] * 10_000 + versionParts[1] * 100 + versionParts[2];
    const record = {
      _id: `win32-stable-${version.replace(/\./g, '-')}`,
      channel: 'stable',
      downloadUrl,
      mandatory,
      notes,
      platform: 'win32',
      published,
      publishedAt: new Date().toISOString(),
      sha256,
      version,
      versionCode,
    };

    fs.mkdirSync(outputRoot, { recursive: true });
    const outputPath = path.join(outputRoot, `app-release-${version}.json`);
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    JSON.parse(fs.readFileSync(temporaryPath, 'utf8'));
    fs.renameSync(temporaryPath, outputPath);

    console.log('\n发布 JSON 已生成：');
    console.log(outputPath);
    console.log(`安装包：${installerPath}`);
    console.log(`SHA-256：${sha256}`);
    console.log('\n可导入 CloudBase 的内容：\n');
    console.log(JSON.stringify(record, null, 2));
  } finally {
    terminal.close();
  }
};

run().catch(error => {
  console.error(`生成发布 JSON 失败：${error.message || error}`);
  process.exitCode = 1;
});
