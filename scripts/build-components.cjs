const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const outputRoot = path.join(root, 'release', 'components');
const venvPython = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');
const python = fs.existsSync(venvPython) ? venvPython : 'python';
const requested = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
const componentIds = requested ? [requested] : ['research-tools', ...(process.platform === 'win32' ? ['team-retouch'] : [])];

const definitions = {
  'research-tools': {
    source: path.join(root, 'python', 'research.py'),
    template: path.join(root, 'components', 'research-tools', 'component.template.json'),
    pyInstallerArgs: [
      '--exclude-module', 'torch', '--exclude-module', 'torchvision', '--exclude-module', 'torchaudio',
      '--exclude-module', 'triton', '--exclude-module', 'matplotlib',
    ],
  },
  'team-retouch': {
    source: path.join(root, 'components', 'team-retouch', 'team_retouch.py'),
    template: path.join(root, 'components', 'team-retouch', 'component.template.json'),
    model: path.join(root, 'components', 'team-retouch', 'models', 'person_detection_mediapipe_2023mar.onnx'),
    pyInstallerArgs: [
      '--collect-all', 'onnxruntime',
      '--paths', path.join(root, 'components', 'team-retouch'),
      '--hidden-import', 'patch_merge',
      '--exclude-module', 'scipy', '--exclude-module', 'matplotlib',
      '--exclude-module', 'torch', '--exclude-module', 'torchvision', '--exclude-module', 'torchaudio',
    ],
  },
};

const probeModule = moduleName => {
  const result = spawnSync(python, ['-c', `import ${moduleName}`], { cwd: root, encoding: 'utf8' });
  return (result.status ?? 1) === 0;
};

const hasDirectML = () => {
  const result = spawnSync(python, ['-c', 'import onnxruntime as ort; raise SystemExit(0 if "DmlExecutionProvider" in ort.get_available_providers() else 1)'], { cwd: root, encoding: 'utf8' });
  return (result.status ?? 1) === 0;
};

const build = id => {
  const definition = definitions[id];
  if (!definition) throw new Error(`Unknown component: ${id}`);
  if (!fs.existsSync(definition.source) || !fs.existsSync(definition.template)) throw new Error(`Component source is incomplete: ${id}`);
  if (definition.model && !fs.existsSync(definition.model)) {
    throw new Error(`Team-retouch model is missing: ${definition.model}\nSee components/team-retouch/MODEL-SOURCE.md`);
  }
  if (id === 'team-retouch' && !probeModule('onnxruntime')) {
    throw new Error('onnxruntime-directml is not installed in the component build environment');
  }
  if (id === 'team-retouch' && !hasDirectML()) {
    throw new Error('The component build environment has ONNX Runtime, but not the DirectML execution provider');
  }

  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(path.join(root, 'build', 'specs', 'components'), { recursive: true });
  const target = path.join(outputRoot, id);
  const relativeTarget = path.relative(outputRoot, target);
  if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error(`Unsafe component output path: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  const dataSeparator = process.platform === 'win32' ? ';' : ':';
  const modelArgs = definition.model ? ['--add-data', `${definition.model}${dataSeparator}models`] : [];
  const result = spawnSync(python, [
    '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm',
    '--specpath', path.join(root, 'build', 'specs', 'components'),
    '--workpath', path.join(root, 'build', 'pyinstaller-components', id),
    '--distpath', outputRoot,
    '--name', id,
    ...definition.pyInstallerArgs,
    ...modelArgs,
    definition.source,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`${id} build failed with code ${result.status}`);
  fs.copyFileSync(definition.template, path.join(target, 'component.json'));
  console.log(`Component ready: ${target}`);
};

try {
  for (const id of componentIds) build(id);
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
