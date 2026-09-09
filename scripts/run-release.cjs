const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const { stdin, stdout } = require('node:process');
const { privateOutputPath } = require('./project-output-paths.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;

const runCommand = (command, args, label) => {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label}失败，退出代码 ${result.status ?? 'unknown'}`);
};

const runNpmScript = (script, args = []) => {
  if (!npmCli) throw new Error('npm_execpath 不可用；请通过 npm run release 启动完整发布流程');
  runCommand(process.execPath, [npmCli, 'run', script, ...(args.length ? ['--', ...args] : [])], `npm run ${script}`);
};

const readGitCommit = () => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !/^[a-f0-9]{40}$/i.test(String(result.stdout || '').trim())) {
    throw new Error('无法读取当前 Git commit');
  }
  return result.stdout.trim();
};

const manifestPathForCurrentSource = () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json 版本号无效：${version}`);
  return path.join(repositoryRoot, 'artifacts', 'installers', 'releases', readGitCommit(), version, 'DELIVERY-MANIFEST.json');
};

const waitForApproval = async approvalPath => {
  if (!stdin.isTTY) throw new Error(`当前终端不能交互确认；请完成 ${approvalPath} 后重新运行 npm run release`);
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    await terminal.question(`\n请完成并保存私有批准文件：\n${approvalPath}\n确认实际审批已经完成后，按回车继续最终门禁；按 Ctrl+C 取消。`);
  } finally {
    terminal.close();
  }
};

const run = async () => {
  const publishArgs = process.argv.slice(2);
  if (publishArgs.some(value => value === '--manifest' || value.startsWith('--manifest='))) {
    throw new Error('npm run release 会自动选择本次不可变清单，请不要传入 --manifest');
  }

  let manifestPath = manifestPathForCurrentSource();
  if (fs.existsSync(manifestPath)) {
    console.log(`继续已有的不可变发布 staging：${manifestPath}`);
  } else {
    runNpmScript('release:prepare');
    manifestPath = manifestPathForCurrentSource();
    if (!fs.existsSync(manifestPath)) throw new Error(`release:prepare 未生成预期清单：${manifestPath}`);
  }

  const approvalPath = privateOutputPath(repositoryRoot, 'audits', 'legal', 'RELEASE_APPROVAL.json');
  if (fs.existsSync(approvalPath)) {
    console.log(`使用已有的私有批准文件：${approvalPath}`);
  } else {
    runNpmScript('release:approval', ['--manifest', manifestPath]);
  }

  await waitForApproval(approvalPath);
  runNpmScript('check:release:final', ['--manifest', manifestPath]);
  runNpmScript('release:publish', ['--manifest', manifestPath, ...publishArgs]);
};

if (require.main === module) run().catch(error => {
  console.error(`\n完整发布流程失败：${error.message || error}`);
  process.exitCode = 1;
});

module.exports = { manifestPathForCurrentSource, readGitCommit };
