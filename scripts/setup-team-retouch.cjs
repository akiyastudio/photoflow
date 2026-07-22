const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const venvRoot = path.join(root, '.venv');
const venvPython = process.platform === 'win32'
  ? path.join(venvRoot, 'Scripts', 'python.exe')
  : path.join(venvRoot, 'bin', 'python');
const systemPython = process.platform === 'win32' ? 'python' : 'python3';

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}`);
};

try {
  if (process.platform !== 'win32') throw new Error('多人裁片修图的 DirectML 运行库目前只支持 Windows');
  if (!fs.existsSync(venvPython)) run(systemPython, ['-m', 'venv', venvRoot]);
  run(venvPython, ['-m', 'pip', 'install', '-r', path.join('components', 'team-retouch', 'requirements.txt')]);
  const probe = spawnSync(venvPython, ['-c', [
    'import onnxruntime as ort',
    'providers=ort.get_available_providers()',
    'print("ONNX Runtime", ort.__version__, providers)',
    'raise SystemExit(0 if "DmlExecutionProvider" in providers else 2)',
  ].join(';')], { cwd: root, stdio: 'inherit' });
  if ((probe.status ?? 1) === 2) throw new Error('ONNX Runtime 已安装，但 DirectML provider 不可用');
  if ((probe.status ?? 1) !== 0) throw new Error('ONNX Runtime 运行库验证失败');
  console.log('Team-retouch runtime is ready.');
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
