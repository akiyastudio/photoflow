const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const releaseConfig = require('./release-config.cjs');
const { verifyStagedRelease, assertStagedReleaseUnchanged } = require('./release-staging.cjs');
const { acquireReleaseLock, releaseLock } = require('./release-lock.cjs');
const { captureArtifactIdentity, assertSourceIdentity } = require('./verify-component-packages.cjs');
const { runPublishStateMachine } = require('./release-publish-state.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const packagePath = path.join(repositoryRoot, 'package.json');

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

const runLegalReleaseReadyGate = (installerPath, manifestPath) => {
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'scripts', 'test-legal-release-evidence.cjs'),
    '--require-ready',
    '--installer', installerPath,
    '--delivery-manifest', manifestPath,
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
const publishReleaseOnce = async ({ url, token, record, idempotencyKey, request = requestJson }) => {
  const body = await request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(record) });
  if (body?.saved !== true) throw new Error('release 数据库未返回 saved=true；发布结果不确定');
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
  const releaseLockHandle = acquireReleaseLock(repositoryRoot);
  try {
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
  if (!args.manifest) throw new Error('发布必须显式提供 --manifest <不可变 staging/DELIVERY-MANIFEST.json>');
  const manifestPath = path.resolve(args.manifest);
  let stagedEvidence = await verifyStagedRelease({ repositoryRoot, manifestPath });
  const installerPath = stagedEvidence.setup.path;
  if (String(stagedEvidence.manifest.version) !== version) throw new Error('staging 版本与 package.json 不一致');
  runLegalReleaseReadyGate(installerPath, manifestPath);
  assertStagedReleaseUnchanged(stagedEvidence);

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
    console.log('\n正在验证 CloudBase release 发布接口和管理员 Token……');
    stagedEvidence = await verifyStagedRelease({ repositoryRoot, manifestPath });
    runLegalReleaseReadyGate(installerPath, manifestPath);
    await assertPublisherReady(token);
    if (persistToken && persistWindowsUserToken(token)) {
      console.log('管理员 Token 已保存到 Windows 用户环境变量，以后发布会自动读取。');
    }

    if (args['skip-upload-pause'] !== 'true') {
      console.log(`请先把新安装包上传或替换到固定发布地址：${releaseConfig.downloadUrl}`);
      await terminal.question('确认下载地址已经提供新版本后，按回车写入 release 数据库……');
    }

    stagedEvidence = await verifyStagedRelease({ repositoryRoot, manifestPath });
    runLegalReleaseReadyGate(installerPath, manifestPath);
    assertStagedReleaseUnchanged(stagedEvidence);
    const versionParts = version.split('.').map(Number);
    const record = { channel: 'stable', downloadUrl: releaseConfig.downloadUrl, mandatory, notes, platform: 'win32', published: true, publishedAt: new Date().toISOString(), sha256: stagedEvidence.setup.sha256, version, versionCode: versionParts[0] * 10_000 + versionParts[1] * 100 + versionParts[2] };
    const attemptRoot = path.join(repositoryRoot, 'artifacts', 'release-publish-attempts'); fs.mkdirSync(attemptRoot, { recursive: true });
    const attemptPath = path.join(attemptRoot, `${stagedEvidence.manifestSha256}.json`);
    if (fs.existsSync(attemptPath)) throw new Error(`此交付清单已有发布尝试；为避免重复线上记录，请先人工核验：${attemptPath}`);
    const outputRoot = path.join(repositoryRoot, 'artifacts', 'cloudbase'); fs.mkdirSync(outputRoot, { recursive: true });
    const outputPath = path.join(outputRoot, `app-release-${version}.json`);
    const priorIdentity = fs.existsSync(outputPath) ? captureArtifactIdentity(outputPath) : null;
    const temporaryPath = `${outputPath}.${stagedEvidence.manifestSha256}.pending`;
    const backupPath = `${outputPath}.${stagedEvidence.manifestSha256}.backup`;
    const attemptBase = { schemaVersion: 1, manifestSha256: stagedEvidence.manifestSha256, version };
    await runPublishStateMachine({
      writeInitialPending: state => fs.writeFileSync(attemptPath, `${JSON.stringify({ ...attemptBase, ...state }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
      prepareLocalRecord: () => {
        fs.rmSync(temporaryPath, { force: true }); let fd;
        try { fd = fs.openSync(temporaryPath, 'wx'); fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`); fs.fsyncSync(fd); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
      },
      publishRemote: () => publishReleaseOnce({ url: `${String(releaseConfig.apiBaseUrl).replace(/\/+$/, '')}/v1/admin/releases`, token, record, idempotencyKey: stagedEvidence.manifestSha256 }),
      promoteLocalRecord: () => {
        if (priorIdentity) assertSourceIdentity(outputPath, priorIdentity); else if (fs.existsSync(outputPath)) throw new Error('本地 release 记录在发布期间被其他进程创建');
        if (priorIdentity) fs.renameSync(outputPath, backupPath);
        fs.renameSync(temporaryPath, outputPath);
        fs.rmSync(backupPath, { force: true });
      },
      assertArtifactsUnchanged: () => assertStagedReleaseUnchanged(stagedEvidence),
      writeState: state => fs.writeFileSync(attemptPath, `${JSON.stringify({ ...attemptBase, ...state, preparedPath: fs.existsSync(temporaryPath) ? temporaryPath : null, backupPath: fs.existsSync(backupPath) ? backupPath : null }, null, 2)}\n`),
    });

    console.log(`\n版本 ${version} 已发布完成。`);
  } finally {
    terminal.close();
  }
  } finally { releaseLock(releaseLockHandle); }
};

if (require.main === module) run().catch(error => {
  console.error(`\n发布流程失败：${error.message || error}`);
  process.exitCode = 1;
});

module.exports = { publishReleaseOnce };
