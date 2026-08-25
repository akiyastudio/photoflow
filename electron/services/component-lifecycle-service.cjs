const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LEGACY_DOMAIN } = require('../compatibility/component-v1-metadata.cjs');

const sha256File = filePath => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  input.on('error', reject);
  input.on('data', chunk => hash.update(chunk));
  input.on('end', () => resolve(hash.digest('hex')));
});

const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const progressFor = text => {
  const markers = [
    ['Checking WSL 2', 10, '正在检查 WSL 2'],
    ['Checking NVIDIA', 20, '正在检查 NVIDIA 驱动'],
    ['Extracting verified package payload', 35, '正在校验并解压离线包'],
    ['Verifying package SHA256', 50, '正在校验高级环境哈希'],
    ['Replacing the registered', 65, '正在替换需要修复的高级环境'],
    ['Installing PhotoFlowNative', 72, '正在安装照片流本地增强环境虚拟磁盘'],
    ['offline environment is ready', 97, '高级引擎离线环境准备完成'],
    ['Unregistering PhotoFlowNative', 70, '正在卸载高级引擎'],
  ];
  return markers.find(([needle]) => text.includes(needle));
};

const advancedStateFromProbe = ({ probe, vhdPresent = false }) => {
  const available = probe?.success !== false && probe?.advancedAvailable === true;
  const installed = available || vhdPresent;
  return {
    available,
    installed,
    advancedAvailable: available,
    state: available ? 'ready' : installed ? 'repair-needed' : 'not-installed',
    advancedError: available ? '' : String(probe?.advancedError || probe?.error || '未检测到可用的高级人物检测环境'),
  };
};
const advancedInstallRoot = component => component.source === 'development' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'PhotoFlow', 'components', component.id, 'advanced', 'wsl', 'PhotoFlowNative')
  : path.join(path.basename(component.path) === 'runtime' ? path.dirname(component.path) : component.path, 'advanced', 'wsl', 'PhotoFlowNative');
const componentDataRoot = component => {
  const installRoot = path.resolve(advancedInstallRoot(component));
  const root = path.resolve(installRoot, '..', '..', '..');
  if (!inside(root, installRoot)) throw new Error('Component advanced install root escapes its controlled data root');
  return root;
};

const runProcess = ({ spawn, command, args, cwd, report, env = null }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, windowsHide: true, ...(env ? { env } : {}) });
  let output = '';
  const consume = chunk => {
    const text = chunk.toString('utf8');
    output = (output + text).slice(-16000);
    const marker = progressFor(text);
    if (marker) report(marker[1], marker[2], { phase: 'running' });
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output.trim() || `组件 lifecycle 进程失败（退出代码 ${code}）`)));
});

const createComponentLifecycleService = ({ app, backgroundTasks, pluginService, spawn, developmentActionRoot, invalidateComponentStatus = () => undefined, writeLog = () => undefined }) => {
  const resolveAction = async (descriptor, action) => {
    const declaration = descriptor?.service?.lifecycleActions?.[action];
    if (!declaration) throw new Error(`Component lifecycle action is not declared: ${action}`);
    const component = pluginService.list().find(item => item.id === descriptor.componentId);
    if (!component?.installed || String(component.version) !== String(descriptor.componentVersion)) throw new Error('组件版本已经变化，请刷新后重试');
    if (component.source === 'user') await pluginService.verifyComponentDirectoryAsync(component.id, component.path, true);
    let entry = declaration.entry;
    if (!fs.existsSync(entry) && component.source === 'development') entry = path.resolve(developmentActionRoot, path.basename(declaration.relativeEntry));
    if (component.source !== 'development' && !inside(component.path, entry)) throw new Error('Component lifecycle action escapes verified component root');
    const stat = await fs.promises.lstat(entry).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('组件 lifecycle 动作文件不存在或类型不安全');
    if ((await sha256File(entry)).toLowerCase() !== declaration.sha256) throw new Error('组件 lifecycle 动作签名/哈希校验失败');
    return { component, entry };
  };

  const invoke = async (payload, _context, descriptor) => {
    const action = String(payload.action || '');
    const allowed = action === 'advanced.install' ? new Set(['action', 'repair']) : new Set(['action']);
    if (Object.keys(payload).some(field => !allowed.has(field))) throw new Error('组件 lifecycle 不接受脚本或路径参数');
    const { component, entry } = await resolveAction(descriptor, action);
    const containerRoot = path.basename(component.path) === 'runtime' ? path.dirname(component.path) : component.path;
    const installRoot = advancedInstallRoot(component);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry];
    let title = '检查高级修图引擎';
    if (action === 'advanced.preflight') args.push('-CheckOnly');
    else if (action === 'advanced.install') {
      title = payload.repair ? '修复高级修图引擎' : '安装高级修图引擎';
      const compatibility = descriptor.advancedRuntime;
      if (!compatibility?.apiVersion) throw new Error('组件没有声明高级运行时兼容策略');
      const entries = await fs.promises.readdir(containerRoot, { withFileTypes: true });
      const packages = entries.filter(item => item.isFile() && LEGACY_DOMAIN.advancedPackagePattern.test(item.name)).map(item => path.join(containerRoot, item.name));
      if (packages.length !== 1) throw new Error(packages.length ? '高级环境目录存在多个离线包' : '未找到高级环境离线包');
      args.push(
        '-InstallRoot', installRoot,
        '-PackagePath', packages[0],
        '-ExpectedComponentVersion', component.version,
        '-ExpectedAdvancedRuntimeApiVersion', String(compatibility.apiVersion),
        '-CompatibleLegacyComponentVersions', compatibility.compatibleLegacyComponentVersions.join(','),
      );
      if (payload.repair) args.push('-Repair');
    } else if (action === 'advanced.uninstall') title = '卸载高级修图引擎';
    else throw new Error(`Unknown component lifecycle action: ${action}`);
    const execution = await backgroundTasks.run({
      type: 'component-lifecycle', title, dedupeKey: `component-lifecycle:${descriptor.componentId}`,
      cancellable: false, resumePolicy: 'atomic', metadata: { componentId: descriptor.componentId, action, advancedRuntimeApiVersion: descriptor.advancedRuntime?.apiVersion },
    }, async task => {
      task.report(1, `${title}已启动`, { phase: 'starting' });
      const output = await runProcess({ spawn, command: 'powershell.exe', args, cwd: path.dirname(entry), report: task.report });
      task.report(99, `${title}即将完成`, { phase: 'complete' });
      return output;
    });
    invalidateComponentStatus();
    writeLog('info', 'Component lifecycle action completed', { componentId: descriptor.componentId, action });
    const message = action === 'advanced.preflight'
      ? execution.result.split(/\r?\n/).find(line => line.includes('OFFLINE_PREFLIGHT_OK'))?.split('|').slice(1).join(' · ') || '高级环境预检通过'
      : `${title}完成`;
    if (action === 'advanced.preflight') {
      let probe;
      try { probe = await pluginService.runJson(component.id, ['probe'], 2 * 60 * 1000); }
      catch (error) { probe = { success: false, advancedError: error.message || String(error) }; }
      const status = advancedStateFromProbe({ probe, vhdPresent: fs.existsSync(path.join(installRoot, 'ext4.vhdx')) });
      return { success: true, preflightPassed: true, message, taskId: execution.task.id, ...status };
    }
    return { success: true, message, taskId: execution.task.id };
  };
  const invokeV2 = (payload, _context, descriptor) => {
    const action = String(payload.action || '');
    if (Object.keys(payload).some(field => field !== 'action')) throw new Error('Component lifecycle action does not accept commands, arguments, or paths');
    if (action === 'describe') return { apiVersion: 2, componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, negotiatedHostApiVersion: descriptor.hostApiVersion, permissions: descriptor.service?.permissions || [], events: descriptor.service?.events || [], lifecycleActions: Object.keys(descriptor.service?.lifecycleActions || {}), state: 'active' };
    if (!['preflight', 'install', 'repair', 'uninstall'].includes(action)) throw new Error('Unknown Component Host V2 lifecycle action');
    if (!descriptor.service?.permissions?.includes('component.lifecycle.manage')) throw new Error('Component lifecycle management permission is not granted');
    const declaration = descriptor?.service?.lifecycleActions?.[action];
    if (!declaration) throw new Error(`Component lifecycle action is not declared: ${action}`);
    if (path.extname(declaration.entry).toLowerCase() !== '.ps1') throw new Error('Component lifecycle V2 currently accepts only verified PowerShell actions');
    return (async () => {
    const { component, entry } = await resolveAction(descriptor, action);
    const title = { preflight: '检查组件环境', install: '安装组件环境', repair: '修复组件环境', uninstall: '卸载组件环境' }[action];
    const execution = await backgroundTasks.run({ type: 'component-lifecycle', title, dedupeKey: `component-lifecycle:${descriptor.componentId}`, cancellable: false, resumePolicy: 'atomic', metadata: { componentId: descriptor.componentId, action } }, async task => {
      task.report(1, `${title}已启动`, { phase: 'starting' });
      const inherited = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'Path', 'PATH', 'PATHEXT', 'ComSpec'].filter(key => typeof process.env[key] === 'string' && process.env[key]).map(key => [key, process.env[key]]));
      const output = await runProcess({ spawn, command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry], cwd: path.dirname(entry), report: task.report, env: { ...inherited, PHOTOFLOW_COMPONENT_LIFECYCLE_ACTION: action, PHOTOFLOW_COMPONENT_ID: descriptor.componentId, PHOTOFLOW_COMPONENT_VERSION: descriptor.componentVersion, PHOTOFLOW_COMPONENT_DATA_ROOT: componentDataRoot(component), PHOTOFLOW_COMPONENT_ADVANCED_RUNTIME_API_VERSION: String(descriptor.advancedRuntime?.apiVersion || ''), PHOTOFLOW_COMPONENT_COMPATIBLE_LEGACY_VERSIONS: (descriptor.advancedRuntime?.compatibleLegacyComponentVersions || []).join(',') } });
      task.report(99, `${title}即将完成`, { phase: 'complete' });
      return output;
    });
    invalidateComponentStatus();
    writeLog('info', 'Component Host V2 lifecycle action completed', { componentId: descriptor.componentId, action });
    return { apiVersion: 2, success: true, action, taskId: execution.task.id, message: `${title}完成` };
    })();
  };
  return { invoke, invokeV2, resolveAction };
};

module.exports = { advancedInstallRoot, advancedStateFromProbe, componentDataRoot, createComponentLifecycleService, inside, progressFor, runProcess, sha256File };
