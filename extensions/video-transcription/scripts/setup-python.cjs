const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const venvRoot = path.join(root, '.venv');
const venvPython = process.platform === 'win32' ? path.join(venvRoot, 'Scripts', 'python.exe') : path.join(venvRoot, 'bin', 'python');
const configuredPython = String(process.env.PHOTOFLOW_TRANSCRIPTION_PYTHON || '').trim();

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout || `${command} exited with ${result.status}`);
  return String(result.stdout || '').trim();
};
const configuredBasePython = configuredPython && fs.statSync(configuredPython, { throwIfNoEntry: false })?.isFile()
  ? run(configuredPython, ['-c', 'import sys; print(sys._base_executable)'], { capture: true }) : '';
const cfgPath = path.join(venvRoot, 'pyvenv.cfg');
const cfgIsPolluted = () => {
  if (!fs.existsSync(cfgPath)) return true;
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  const executable = cfg.split(/\r?\n/).find(line => /^executable\s*=/i.test(line))?.split('=').slice(1).join('=').trim() || '';
  const command = cfg.split(/\r?\n/).find(line => /^command\s*=/i.test(line))?.split('=').slice(1).join('=').trim() || '';
  const commandSource = command.split(/\s+-m\s+venv\s+/i)[0] || '';
  return [executable, commandSource].some(value => /(?:^|[\\/])\.venv(?:[\\/]|$)/i.test(value));
};
const ownershipProbe = () => spawnSync(venvPython, ['-c', "import pathlib,sys; root=pathlib.Path(sys.prefix).resolve(); import faster_whisper,opencc; files=[pathlib.Path(faster_whisper.__file__).resolve(),pathlib.Path(opencc.__file__).resolve()]; sites=[pathlib.Path(p).resolve() for p in sys.path if p and p.lower().replace('\\\\','/').endswith('site-packages')]; raise SystemExit(3 if not all(p.is_relative_to(root) for p in files+sites) else 0)"], { cwd: root, stdio: 'ignore', windowsHide: true });
if (fs.existsSync(venvPython) && (cfgIsPolluted() || ownershipProbe().status === 3)) {
  if (path.resolve(venvRoot) !== path.join(root, '.venv')) throw new Error('拒绝重建非插件私有环境');
  fs.rmSync(venvRoot, { recursive: true, force: true });
}
if (!fs.existsSync(venvPython)) {
  if (configuredBasePython) run(configuredBasePython, ['-m', 'venv', venvRoot]);
  else if (process.platform === 'win32') run('py', ['-3.12', '-m', 'venv', venvRoot]);
  else run('python3', ['-m', 'venv', venvRoot]);
}
const localSitePackages = run(venvPython, ['-c', "import sys; print(next(p for p in sys.path if p.lower().replace('\\\\','/').endswith('site-packages')))"] , { capture: true });
fs.rmSync(path.join(localSitePackages, 'photoflow-transcription-seed.pth'), { force: true });
const probe = spawnSync(venvPython, ['-c', 'import faster_whisper, opencc'], { cwd: root, stdio: 'ignore', windowsHide: true });
if (probe.status !== 0) run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt']);
const ownership = run(venvPython, ['-c', "import faster_whisper,opencc,sys,pathlib; root=pathlib.Path(sys.prefix).resolve(); files=[pathlib.Path(faster_whisper.__file__).resolve(),pathlib.Path(opencc.__file__).resolve()]; assert all(p.is_relative_to(root) for p in files), files; assert not list((root/'Lib'/'site-packages').glob('*seed*.pth')); print('self-contained')"], { capture: true });
if (ownership !== 'self-contained') throw new Error('插件 Python 环境自包含验证失败');
console.log(`Video transcription private Python environment ready: ${venvPython}`);
