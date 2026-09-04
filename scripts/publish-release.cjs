const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const releaseConfig = require('./release-config.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const packagePath = path.join(repositoryRoot, 'package.json');
const installerRoot = path.join(repositoryRoot, 'artifacts', 'installers');

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

const runLegalReleaseReadyGate = installerPath => {
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'scripts', 'test-legal-release-evidence.cjs'),
    '--require-ready',
    '--installer', installerPath,
  ], { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('法律发布批准严格门禁未通过，未读取 Token 且未执行网络或发布操作');
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

const findInstaller = version => {
  if (!fs.existsSync(installerRoot)) throw new Error(`安装包目录不存在：${installerRoot}；请先执行 npm run electron:build`);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactName = new RegExp(`Setup\\s+${escapedVersion}\\.exe$`, 'i');
  const candidates = fs.readdirSync(installerRoot)
    .filter(name => exactName.test(name))
    .map(name => path.join(installerRoot, name));
  if (!candidates.length) throw new Error(`没有找到版本 ${version} 的安装包；请先执行 npm run electron:build`);
  return candidates[0];
};

const hiddenQuestion = prompt => {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('当前终端无法安全读取隐藏 Token；请改用交互式 PowerShell 或 set-version.bat 所在终端');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const complete = result => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const fail = error => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === '\u0003') return fail(new Error('已取消 Token 输入'));
        if (character === '\r' || character === '\n') return complete(value);
        if (character === '\u007f' || character === '\b') {
          if (value) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (character >= ' ') {
          value += character;
          stdout.write('*');
        }
      }
    };
    stdout.write(prompt);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
};

const readWindowsUserToken = () => {
  if (process.platform !== 'win32') return '';
  const command = "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);[Console]::Out.Write([Environment]::GetEnvironmentVariable('PHOTOFLOW_ADMIN_TOKEN','User'))";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim();
};

const persistWindowsUserToken = token => {
  if (process.platform !== 'win32') return false;
  const command = "[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false);$value=[Console]::In.ReadToEnd().Trim();if([string]::IsNullOrWhiteSpace($value)){exit 2};[Environment]::SetEnvironmentVariable('PHOTOFLOW_ADMIN_TOKEN',$value,'User')";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: token,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`无法保存管理员 Token，退出代码 ${result.status ?? 'unknown'}`);
  return true;
};

const validateAdminToken = value => {
  const token = String(value || '').trim();
  if (!token) throw new Error('Token 不能为空');
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('Token 包含非 ASCII 或不可见字符；请使用 CloudBase 中由十六进制随机字符串生成的 Token，并只复制变量值');
  }
  return token;
};

const askYesNo = async (terminal, prompt, fallback = false) => {
  while (true) {
    const answer = (await terminal.question(prompt)).trim().toLowerCase();
    if (!answer) return fallback;
    if (['y', 'yes', 'true', '1', '是'].includes(answer)) return true;
    if (['n', 'no', 'false', '0', '否'].includes(answer)) return false;
    console.log('请输入 y 或 n。');
  }
};

const run = async () => {
  const args = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!VERSION_PATTERN.test(version)) throw new Error('package.json 中的版本号无效；请先运行 set-version.bat');
  const versionFields = version.split('.').map(Number);
  if (versionFields.some(value => !Number.isSafeInteger(value) || value < 0)
    || versionFields[1] > 99 || versionFields[2] > 99) {
    throw new Error('版本号各段必须是非负整数，且第二、第三段不能超过 99');
  }
  if (args.version && String(args.version).trim() !== version) {
    throw new Error(`--version 与 package.json 不一致；当前版本是 ${version}`);
  }
  const installerPath = path.resolve(args.installer || findInstaller(version));
  if (!fs.existsSync(installerPath) || !fs.statSync(installerPath).isFile()) throw new Error(`安装包不存在：${installerPath}`);
  runLegalReleaseReadyGate(installerPath);
  runCommand(process.execPath, [
    path.join(repositoryRoot, 'scripts', 'generate-delivery-manifest.cjs'),
    '--installer', installerPath,
  ], '验证 Setup 与组件 ZIP 并生成交付清单（组件 ZIP 不由本发布脚本上传）');

  let token = String(process.env.PHOTOFLOW_ADMIN_TOKEN || '').trim() || readWindowsUserToken();
  let persistToken = false;
  if (!token) {
    token = await hiddenQuestion('未配置 PHOTOFLOW_ADMIN_TOKEN，请粘贴 CloudBase 管理 Token：');
    persistToken = true;
  }
  token = validateAdminToken(token);
  process.env.PHOTOFLOW_ADMIN_TOKEN = token;

  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n准备发布版本：${version}`);
    console.log(`安装包：${installerPath}`);

    let notes = String(args.notes || '').trim();
    if (!notes) notes = (await terminal.question('请输入发布说明：')).trim();
    if (!notes) throw new Error('发布说明不能为空');
    if (notes.length > 4000) throw new Error('发布说明不能超过 4000 个字符');
    let mandatory;
    if (args.mandatory === undefined) {
      mandatory = await askYesNo(terminal, '是否强制更新？输入 y 表示强制更新，输入 n 表示普通更新 [y/N]：');
    } else {
      const value = String(args.mandatory).trim().toLowerCase();
      if (!['true', 'false', 'y', 'n', 'yes', 'no', '1', '0', '是', '否'].includes(value)) {
        throw new Error('--mandatory 只接受 true/false 或 y/n');
      }
      mandatory = ['true', 'y', 'yes', '1', '是'].includes(value);
    }
    const mandatoryArgument = String(mandatory);

    console.log('\n正在验证 CloudBase release 发布接口和管理员 Token……');
    await assertPublisherReady(token);
    if (persistToken && persistWindowsUserToken(token)) {
      console.log('管理员 Token 已保存到 Windows 用户环境变量，以后发布会自动读取。');
    }

    if (args['skip-upload-pause'] !== 'true') {
      console.log(`请先把新安装包上传或替换到固定发布地址：${releaseConfig.downloadUrl}`);
      await terminal.question('确认下载地址已经提供新版本后，按回车写入 release 数据库……');
    }

    runCommand(process.execPath, [
      path.join(repositoryRoot, 'scripts', 'generate-release-json.cjs'),
      '--version', version,
      '--notes', notes,
      '--mandatory', mandatoryArgument,
      '--installer', installerPath,
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
