const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const root = path.resolve(__dirname, '..');
const VERSION_PATTERN = /^\d{2}\.\d{1,2}\.\d{1,2}$/;

const appModule = {
  id: 'app',
  label: '主程序',
  versionSource: 'package.json',
  files: [['package.json', 1], ['package-lock.json', 2]],
  build: { type: 'npm', cwd: root, args: ['run', 'electron:build'] },
};

const discoverComponentModules = () => fs.readdirSync(path.join(root, 'extensions'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap(entry => {
    const componentRoot = path.join(root, 'extensions', entry.name);
    const packagePath = path.join(componentRoot, 'package.json');
    if (!fs.existsSync(packagePath)) return [];
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const manifestName = String(packageJson.photoflowComponent?.manifest || '').trim();
    if (!manifestName || !packageJson.scripts?.['package:host']) return [];
    const manifestPath = path.join(componentRoot, manifestName);
    if (!fs.existsSync(manifestPath)) throw new Error(`插件清单不存在：${path.relative(root, manifestPath)}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const relativeRoot = path.relative(root, componentRoot).replace(/\\/g, '/');
    const files = [[`${relativeRoot}/${manifestName}`, 1], [`${relativeRoot}/package.json`, 1]];
    if (fs.existsSync(path.join(componentRoot, 'package-lock.json'))) files.push([`${relativeRoot}/package-lock.json`, 2]);
    return [{
      id: String(manifest.id || entry.name),
      label: String(manifest.displayName || manifest.name || manifest.id || entry.name),
      versionSource: `${relativeRoot}/${manifestName}`,
      files,
      build: { type: 'component' },
    }];
  });

const modules = [appModule, ...discoverComponentModules()];

const parseArguments = values => {
  const result = { dryRun: false, selected: null, date: '' };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--dry-run') result.dryRun = true;
    else if (value === '--select') result.selected = String(values[++index] || '').split(',').map(item => item.trim()).filter(Boolean);
    else if (value === '--date') result.date = String(values[++index] || '').trim();
    else if (index === 0 && VERSION_PATTERN.test(value)) result.date = value;
    else throw new Error(`无法识别参数：${value}`);
  }
  return result;
};

const todayVersion = () => {
  const now = new Date();
  return `${String(now.getFullYear() % 100).padStart(2, '0')}.${now.getMonth() + 1}.${now.getDate()}`;
};

const validateVersion = version => {
  if (!VERSION_PATTERN.test(version)) throw new Error(`版本号必须使用 YY.M.DD 格式：${version}`);
  const [year, month, day] = version.split('.').map(Number);
  const date = new Date(2000 + year, month - 1, day);
  if (date.getFullYear() !== 2000 + year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`版本号不是有效日期：${version}`);
  }
};

const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const currentVersion = module => String(readJson(module.versionSource).version || '').trim();

const replaceVersionFields = (text, version, expected) => {
  let replacements = 0;
  const updated = text.replace(/("version"\s*:\s*")[^"]*(")/g, (match, prefix, suffix) => {
    if (replacements >= expected) return match;
    replacements += 1;
    return `${prefix}${version}${suffix}`;
  });
  if (replacements !== expected) throw new Error(`预期修改 ${expected} 个版本字段，实际找到 ${replacements} 个`);
  JSON.parse(updated);
  return updated;
};

const writeTextAtomic = (filePath, text) => {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  JSON.parse(fs.readFileSync(temporary, 'utf8'));
  fs.renameSync(temporary, filePath);
};

const updateSelectedVersions = (selected, version, dryRun) => {
  const updates = selected.flatMap(module => module.files.map(([relative, expected]) => {
    const filePath = path.join(root, relative);
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, relative, original, updated: replaceVersionFields(original, version, expected) };
  }));
  if (dryRun) return updates;
  const written = [];
  try {
    for (const update of updates) {
      writeTextAtomic(update.filePath, update.updated);
      written.push(update);
    }
  } catch (error) {
    for (const update of [...written].reverse()) {
      try { writeTextAtomic(update.filePath, update.original); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
  for (const module of selected) {
    for (const [relative] of module.files) {
      if (String(readJson(relative).version || '') !== version) throw new Error(`版本写入校验失败：${relative}`);
    }
  }
  return updates;
};

const runCommand = (command, args, cwd, label) => {
  console.log(`\n=== 重新打包：${label} ===`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`${label}打包失败，退出代码 ${result.status ?? 'unknown'}`);
};

const runNpm = (args, cwd, label) => {
  if (process.platform === 'win32') {
    runCommand(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], cwd, label);
  } else runCommand('npm', args, cwd, label);
};

const packageModule = module => {
  if (module.build.type === 'npm') return runNpm(module.build.args, module.build.cwd, module.label);
  if (module.build.type === 'component') return runNpm(['run', 'build:components', '--', '--only', module.id], root, module.label);
  throw new Error(`没有配置打包方式：${module.id}`);
};

const askChanged = async (terminal, module, latest) => {
  const current = currentVersion(module);
  while (true) {
    const answer = (await terminal.question(`${module.label}（当前 ${current}）有修改吗？输入 y 更新到 ${latest}，输入 n 跳过 [y/N]：`)).trim().toLowerCase();
    if (!answer || answer === 'n' || answer === 'no' || answer === '否') return false;
    if (answer === 'y' || answer === 'yes' || answer === '是') return true;
    console.log('请输入 y 或 n。');
  }
};

const run = async () => {
  const args = parseArguments(process.argv.slice(2));
  const latest = args.date || todayVersion();
  validateVersion(latest);

  let selected;
  if (args.selected) {
    const requested = new Set(args.selected.includes('all') ? modules.map(module => module.id) : args.selected);
    const unknown = [...requested].filter(id => !modules.some(module => module.id === id));
    if (unknown.length) throw new Error(`未知模块：${unknown.join(', ')}`);
    selected = modules.filter(module => requested.has(module.id));
  } else {
    console.log(`\n本次最新版本号：${latest}\n`);
    const terminal = readline.createInterface({ input: stdin, output: stdout });
    try {
      selected = [];
      for (const module of modules) if (await askChanged(terminal, module, latest)) selected.push(module);
    } finally {
      terminal.close();
    }
  }

  if (!selected.length) {
    console.log('\n没有选择需要更新的模块，版本和安装包均未修改。');
    return;
  }

  console.log(`\n将更新并重新打包：${selected.map(module => module.label).join('、')}`);
  const updates = updateSelectedVersions(selected, latest, args.dryRun);
  for (const update of updates) console.log(`${args.dryRun ? '[预览] ' : ''}${update.relative} -> ${latest}`);
  if (args.dryRun) {
    console.log('\n预览完成：没有写入版本，也没有执行打包。');
    return;
  }

  const failures = [];
  for (const module of selected) {
    try { packageModule(module); }
    catch (error) {
      failures.push(`${module.label}：${error.message || error}`);
      console.error(`\n${failures.at(-1)}`);
    }
  }
  if (failures.length) throw new Error(`以下模块打包失败：\n- ${failures.join('\n- ')}`);
  console.log(`\n版本 ${latest} 的所有选中模块均已重新打包。`);
};

run().catch(error => {
  console.error(`\n版本管理失败：${error.message || error}`);
  process.exitCode = 1;
});
