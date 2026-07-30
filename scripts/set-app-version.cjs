const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const repositoryRoot = path.resolve(__dirname, '..');
const packagePath = path.join(repositoryRoot, 'package.json');
const lockPath = path.join(repositoryRoot, 'package-lock.json');
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeTextAtomic = (filePath, value) => {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, value, 'utf8');
  JSON.parse(fs.readFileSync(temporaryPath, 'utf8'));
  fs.renameSync(temporaryPath, filePath);
};

const replaceVersionFields = (text, version, maximum) => {
  let replacements = 0;
  const updated = text.replace(/("version"\s*:\s*")[^"]*(")/g, (match, prefix, suffix) => {
    if (replacements >= maximum) return match;
    replacements += 1;
    return `${prefix}${version}${suffix}`;
  });
  if (replacements !== maximum) throw new Error(`预期修改 ${maximum} 个版本字段，实际找到 ${replacements} 个`);
  return updated;
};

const run = async () => {
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);
  let version = String(process.argv[2] || '').trim();
  let terminal;
  if (!version) {
    terminal = readline.createInterface({ input: stdin, output: stdout });
    version = (await terminal.question(`请输入新版本号（当前 ${packageJson.version}）：`)).trim();
  }
  terminal?.close();

  if (!VERSION_PATTERN.test(version)) throw new Error('版本号必须使用 x.y.z 格式，例如 26.7.31');
  const fields = version.split('.').map(Number);
  if (fields.some(field => !Number.isSafeInteger(field) || field < 0) || fields[1] > 99 || fields[2] > 99) {
    throw new Error('版本号各段必须是非负整数，且第二、第三段不能超过 99');
  }
  if (packageJson.version === version && packageLock.version === version && packageLock.packages?.['']?.version === version) {
    console.log(`版本号已经是 ${version}，无需修改。`);
    return;
  }

  if (!packageLock.packages || !packageLock.packages['']) throw new Error('package-lock.json 缺少 packages[""]');
  const packageText = fs.readFileSync(packagePath, 'utf8');
  const lockText = fs.readFileSync(lockPath, 'utf8');
  writeTextAtomic(packagePath, replaceVersionFields(packageText, version, 1));
  writeTextAtomic(lockPath, replaceVersionFields(lockText, version, 2));
  const savedPackage = readJson(packagePath);
  const savedLock = readJson(lockPath);
  if (savedPackage.version !== version || savedLock.version !== version || savedLock.packages?.['']?.version !== version) {
    throw new Error('写入后的版本字段校验失败');
  }

  console.log(`版本号已更新为 ${version}`);
  console.log(`- ${packagePath}`);
  console.log(`- ${lockPath}`);
  console.log('软件内“关于”和许可证页面会在下次构建时自动显示这个版本。');
  console.log('下一步可执行 npm run electron:build 生成安装包。');
};

run().catch(error => {
  console.error(`修改版本号失败：${error.message || error}`);
  process.exitCode = 1;
});
