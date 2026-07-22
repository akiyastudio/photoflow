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
  // OpenCV packages share the same cv2 directory. Uninstall every variant
  // before reinstalling the one supported build so stale DLLs cannot leak into
  // either component package.
  const opencvProbe = spawnSync(venvPython, ['-c', [
    'import importlib.metadata as metadata',
    'packages = sorted(f"{dist.metadata.get(\'Name\', \'\').lower()}=={dist.version}" for dist in metadata.distributions() if dist.metadata.get("Name", "").lower().startswith("opencv-"))',
    'print(",".join(packages))',
  ].join(';')], { cwd: root, encoding: 'utf8' });
  if (opencvProbe.stdout.trim() !== 'opencv-python-headless==4.12.0.88') {
    run(venvPython, ['-m', 'pip', 'uninstall', '-y',
      'opencv-python', 'opencv-python-headless',
      'opencv-contrib-python', 'opencv-contrib-python-headless']);
  }
  run(venvPython, ['-m', 'pip', 'install', '-r', path.join('components', 'team-retouch', 'requirements.txt')]);
  run(venvPython, ['-c', [
    'import importlib.metadata as metadata, pathlib, cv2',
    'distribution = metadata.distribution("opencv-python-headless")',
    'owned = {pathlib.Path(distribution.locate_file(item)).resolve() for item in distribution.files or []}',
    'cv2_root = pathlib.Path(cv2.__file__).parent',
    'orphans = [path for path in cv2_root.glob("opencv_videoio_ffmpeg*_64.dll") if path.resolve() not in owned]',
    '[path.unlink() for path in orphans]',
    'print("Removed orphan OpenCV DLLs:", ", ".join(path.name for path in orphans) or "none")',
  ].join(';')]);
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
