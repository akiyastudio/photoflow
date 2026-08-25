const { spawnSync } = require('child_process');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const releaseConfig = require('./release-config.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

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

const runCommand = (command, args, label) => {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label}失败，退出代码 ${result.status ?? 'unknown'}`);
};

const requestJson = async (url, options) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const detail = body.error || body.raw || `${response.status} ${response.statusText}`;
    throw new Error(`release 数据库接口不可用：${detail}`);
  }
  return body;
};

const assertPublisherReady = async token => {
  const baseUrl = String(releaseConfig.apiBaseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('electron/cloud-config.cjs 中缺少有效的 HTTPS apiBaseUrl');
  const status = await requestJson(`${baseUrl}/v1/admin/releases/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (status.ready !== true) throw new Error('CloudBase release 发布接口尚未就绪');
};

const run = async () => {
  const args = parseArguments(process.argv.slice(2));
  const token = String(process.env.PHOTOFLOW_ADMIN_TOKEN || '').trim();
  if (!token) {
    throw new Error('缺少 PHOTOFLOW_ADMIN_TOKEN 环境变量；请配置为云函数使用的同一个管理员 Token');
  }

  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    let version = String(args.version || '').trim();
    if (!version) version = (await terminal.question('请输入发布版本号（x.y.z）：')).trim();
    if (!VERSION_PATTERN.test(version)) throw new Error('版本号必须使用 x.y.z 格式，例如 26.8.25');
    const versionFields = version.split('.').map(Number);
    if (versionFields.some(value => !Number.isSafeInteger(value) || value < 0)
      || versionFields[1] > 99 || versionFields[2] > 99) {
      throw new Error('版本号各段必须是非负整数，且第二、第三段不能超过 99');
    }

    let notes = String(args.notes || '').trim();
    if (!notes) notes = (await terminal.question('请输入发布说明：')).trim();
    if (!notes) throw new Error('发布说明不能为空');
    if (notes.length > 4000) throw new Error('发布说明不能超过 4000 个字符');
    const mandatoryArgument = String(args.mandatory || 'false').trim().toLowerCase();
    if (!['true', 'false'].includes(mandatoryArgument)) throw new Error('--mandatory 只接受 true 或 false');

    console.log('\n正在验证 CloudBase release 发布接口和管理员 Token……');
    await assertPublisherReady(token);

    runCommand(process.execPath, [path.join(repositoryRoot, 'scripts', 'set-app-version.cjs'), version], '更新版本号');

    if (args['skip-build'] !== 'true') {
      if (process.platform === 'win32') {
        runCommand(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run electron:build'], '构建 Windows 安装包');
      } else {
        runCommand('npm', ['run', 'electron:build'], '构建 Windows 安装包');
      }
    }

    if (args['skip-upload-pause'] !== 'true') {
      console.log(`\n安装包已经生成在：${path.join(repositoryRoot, 'artifacts', 'installers')}`);
      console.log(`请先把新安装包上传或替换到固定发布地址：${releaseConfig.downloadUrl}`);
      await terminal.question('确认下载地址已经提供新版本后，按回车写入 release 数据库……');
    }

    runCommand(process.execPath, [
      path.join(repositoryRoot, 'scripts', 'generate-release-json.cjs'),
      '--version', version,
      '--notes', notes,
      '--mandatory', mandatoryArgument,
      '--published', 'true',
      '--publish', 'true',
    ], '生成并发布 release 记录');

    console.log(`\n版本 ${version} 已发布完成。`);
  } finally {
    terminal.close();
  }
};

run().catch(error => {
  console.error(`\n发布流程失败：${error.message || error}`);
  process.exitCode = 1;
});
