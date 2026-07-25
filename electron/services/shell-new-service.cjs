const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const COMMON_LABELS = new Map([
  ['.txt', '文本文档'],
  ['.rtf', 'RTF 文档'],
  ['.bmp', 'BMP 图像'],
  ['.psd', 'Adobe Photoshop 图像'],
  ['.doc', 'Microsoft Word 文档'],
  ['.docx', 'Microsoft Word 文档'],
  ['.ppt', 'Microsoft PowerPoint 演示文稿'],
  ['.pptx', 'Microsoft PowerPoint 演示文稿'],
  ['.xls', 'Microsoft Excel 工作表'],
  ['.xlsx', 'Microsoft Excel 工作表'],
  ['.zip', 'ZIP 压缩文件'],
]);
const COMMON_ORDER = ['.txt', '.rtf', '.bmp', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.psd', '.zip'];
const EMPTY_BMP_BASE64 = Buffer.from('424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b00000000000000000000ffffff00', 'hex').toString('base64');
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$results = [System.Collections.Generic.List[object]]::new()
$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
& "$env:SystemRoot\System32\reg.exe" query HKCR /f ShellNew /k /s 2>$null | ForEach-Object {
  $registryPath = ([string]$_).Trim()
  if ($registryPath -notmatch '^HKEY_CLASSES_ROOT\\(\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31})(?:\\.*)?\\ShellNew$') { return }
  $extension = $Matches[1].ToLowerInvariant()
  if ($seen.Contains($extension)) { return }
  $extensionKey = Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $extension)
  if (-not $extensionKey) { return }
  $progId = [string]$extensionKey.GetValue('')
  $shellNew = Get-Item -LiteralPath ('Registry::' + $registryPath)
  if (-not $shellNew) { return }
  $names = @($shellNew.GetValueNames())
  if ($names -contains 'Command' -or $names -contains 'Handler') { return }
  $method = ''
  $fileName = ''
  $dataBase64 = ''
  if ($names -contains 'NullFile') { $method = 'null' }
  elseif ($names -contains 'FileName') { $method = 'template'; $fileName = [string]$shellNew.GetValue('FileName') }
  elseif ($names -contains 'Data') {
    $value = $shellNew.GetValue('Data')
    if ($value -is [byte[]]) { $method = 'data'; $dataBase64 = [Convert]::ToBase64String($value) }
  }
  # Command and handler-based entries are intentionally not executed by the app.
  if (-not $method) { return }
  $label = ''
  if ($progId) {
    $progIdKey = Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $progId)
    if ($progIdKey) { $label = [string]$progIdKey.GetValue('') }
  }
  if (-not $label -or $label.StartsWith('@')) { $label = $extension.TrimStart('.').ToUpperInvariant() + ' 文件' }
  $results.Add([pscustomobject]@{ id=$extension; extension=$extension; label=$label; method=$method; fileName=$fileName; dataBase64=$dataBase64 })
  [void]$seen.Add($extension)
}
$results | ConvertTo-Json -Compress -Depth 4
`;

const runPowerShellJson = script => new Promise((resolve, reject) => {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-4 * 1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  const timer = setTimeout(() => {
    if (!child.killed) child.kill();
    reject(new Error('读取 Windows 新建文件类型超时'));
  }, 60000);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => {
    clearTimeout(timer);
    if (code !== 0) { reject(new Error(stderr.trim() || '无法读取 Windows 新建文件类型')); return; }
    try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]')); }
    catch { reject(new Error('Windows 新建文件类型返回格式无效')); }
  });
});

const expandEnvironmentVariables = value => String(value || '').replace(/%([^%]+)%/g, (_match, name) => process.env[name] || process.env[Object.keys(process.env).find(key => key.toLocaleLowerCase() === name.toLocaleLowerCase())] || '');
const safeBaseName = value => String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '') || '文件';

const createShellNewService = ({ app } = {}) => {
  let cachedTypes = null;
  let loading = null;
  const cachePath = () => app?.getPath ? path.join(app.getPath('userData'), 'shell-new-types-cache.json') : '';
  const readPersistentCache = async () => {
    const filePath = cachePath();
    if (!filePath) return null;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
      const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      if (parsed?.version !== CACHE_VERSION || !Number.isFinite(parsed.savedAt) || !Array.isArray(parsed.types)) return null;
      const types = parsed.types.filter(item => /^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(item?.extension || '') && ['null', 'data', 'template'].includes(item?.method)).slice(0, 80);
      if (!types.length) return null;
      return { savedAt: parsed.savedAt, types };
    } catch {
      return null;
    }
  };
  const writePersistentCache = async types => {
    const filePath = cachePath();
    if (!filePath) return;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), types }), 'utf8');
  };

  const list = async ({ refresh = false } = {}) => {
    const publicType = item => ({ id: item.id, extension: item.extension, label: item.label, method: item.method, iconDataUrl: item.iconDataUrl || '' });
    if (loading) return loading;
    if (!refresh && cachedTypes) return cachedTypes.map(publicType);
    loading = (async () => {
      const persistentCache = await readPersistentCache();
      if (!refresh && persistentCache && Date.now() - persistentCache.savedAt < CACHE_MAX_AGE_MS) {
        cachedTypes = persistentCache.types;
        return cachedTypes.map(publicType);
      }
      // Do not turn a transient registry/PowerShell failure into a permanently
      // cached three-item fallback menu. Let the IPC layer report it and retry
      // the next time the user opens the menu.
      let discovered;
      try {
        discovered = process.platform === 'win32' ? await runPowerShellJson(DISCOVERY_SCRIPT) : [];
      } catch (error) {
        if (!persistentCache) throw error;
        cachedTypes = persistentCache.types;
        return cachedTypes.map(publicType);
      }
      const normalized = (Array.isArray(discovered) ? discovered : [discovered]).filter(item => /^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(item?.extension || '')).map(item => ({
        id: item.extension.toLocaleLowerCase(),
        extension: item.extension.toLocaleLowerCase(),
        label: COMMON_LABELS.get(item.extension.toLocaleLowerCase()) || safeBaseName(item.label),
        method: item.method,
        templatePath: item.fileName || '',
        dataBase64: item.dataBase64 || '',
      }));
      const fallbacks = [
        { id: '.txt', extension: '.txt', label: '文本文档', method: 'null', templatePath: '', dataBase64: '' },
        { id: '.rtf', extension: '.rtf', label: 'RTF 文档', method: 'data', templatePath: '', dataBase64: Buffer.from('{\\rtf1\\ansi\\deff0 \\par}', 'utf8').toString('base64') },
        { id: '.bmp', extension: '.bmp', label: 'BMP 图像', method: 'data', templatePath: '', dataBase64: EMPTY_BMP_BASE64 },
      ];
      for (const fallback of fallbacks) if (!normalized.some(item => item.extension === fallback.extension)) normalized.push(fallback);
      for (let index = normalized.length - 1; index >= 0; index -= 1) if (normalized[index].extension === '.lnk') normalized.splice(index, 1);
      normalized.sort((left, right) => {
        const leftIndex = COMMON_ORDER.indexOf(left.extension);
        const rightIndex = COMMON_ORDER.indexOf(right.extension);
        if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
        return left.label.localeCompare(right.label, 'zh-CN', { numeric: true, sensitivity: 'base' });
      });
      const nextTypes = normalized.slice(0, 80);
      if (app?.getFileIcon) {
        const iconDirectory = path.join(app.getPath('temp'), 'Photoflow-shell-new-icons');
        await fs.promises.mkdir(iconDirectory, { recursive: true });
        for (const descriptor of nextTypes) {
          const iconSource = path.join(iconDirectory, `type${descriptor.extension}`);
          try {
            await fs.promises.writeFile(iconSource, Buffer.alloc(0));
            const icon = await app.getFileIcon(iconSource, { size: 'normal' });
            descriptor.iconDataUrl = icon.isEmpty() ? '' : icon.toDataURL();
          } catch {
            descriptor.iconDataUrl = '';
          } finally {
            await fs.promises.rm(iconSource, { force: true }).catch(() => undefined);
          }
        }
      }
      // Publish the complete snapshot only after every descriptor and icon is
      // ready, so concurrent menu requests cannot observe a partial result.
      cachedTypes = nextTypes;
      await writePersistentCache(cachedTypes).catch(() => undefined);
      return cachedTypes.map(publicType);
    })().finally(() => { loading = null; });
    return loading;
  };

  const resolveTemplate = requested => {
    const expanded = expandEnvironmentVariables(String(requested || '').replace(/^"|"$/g, ''));
    const candidates = path.isAbsolute(expanded) ? [expanded] : [
      path.join(process.env.WINDIR || 'C:\\Windows', 'ShellNew', expanded),
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Templates', expanded),
      path.join(process.env.PROGRAMDATA || '', 'Microsoft', 'Windows', 'Templates', expanded),
    ];
    return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
  };

  const create = async (typeId, directory, uniqueDestination) => {
    await list();
    const descriptor = cachedTypes.find(item => item.id === String(typeId || '').toLocaleLowerCase());
    if (!descriptor) throw new Error('不支持该新建文件类型');
    const baseName = `新建 ${safeBaseName(descriptor.label)}`;
    const destination = uniqueDestination(directory, `${baseName}${descriptor.extension}`);
    if (descriptor.method === 'null') await fs.promises.writeFile(destination, Buffer.alloc(0), { flag: 'wx' });
    else if (descriptor.method === 'data') await fs.promises.writeFile(destination, Buffer.from(descriptor.dataBase64, 'base64'), { flag: 'wx' });
    else if (descriptor.method === 'template') {
      const template = resolveTemplate(descriptor.templatePath);
      if (!template) throw new Error(`找不到“${descriptor.label}”的 Windows 模板文件`);
      await fs.promises.copyFile(template, destination, fs.constants.COPYFILE_EXCL);
    } else throw new Error('该文件类型需要外部程序创建，当前未开放执行');
    return { name: path.basename(destination), path: destination, extension: descriptor.extension };
  };

  return { list, create };
};

module.exports = { createShellNewService };
