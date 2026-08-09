const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const releaseRoot = path.join(root, 'artifacts', 'installers');
const outputRoot = path.join(releaseRoot, 'components');
const pythonBuildRoot = path.join(root, 'artifacts', 'python-build');
const venvPython = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');
const python = fs.existsSync(venvPython) ? venvPython : 'python';
const requested = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
const componentIds = requested ? [requested] : (process.platform === 'win32' ? ['team-retouch'] : []);

const definitions = {
  'team-retouch': {
    source: path.join(root, 'extensions', 'team-retouch', 'team_retouch.py'),
    template: path.join(root, 'extensions', 'team-retouch', 'component.template.json'),
    models: [
      { path: path.join(root, 'extensions', 'team-retouch', 'models', 'rtmdet-ins_m_640x640.onnx'), minBytes: 100 * 1024 * 1024 },
      { path: path.join(root, 'extensions', 'team-retouch', 'models', 'face_detection_yunet_2023mar.onnx'), minBytes: 200 * 1024 },
      { path: path.join(root, '.cache', 'model-lab', 'adaface', 'adaface_ir18_webface4m.onnx'), minBytes: 80 * 1024 * 1024 },
      { path: path.join(root, '.cache', 'model-lab', 'osnet', 'osnet_x1_0_msmt17.onnx'), minBytes: 7 * 1024 * 1024 },
    ],
    advancedScripts: [
      path.join(root, 'extensions', 'team-retouch', 'advanced', 'pairdetr_service.py'),
      path.join(root, 'extensions', 'team-retouch', 'advanced', 'sam2_service.py'),
    ],
    advancedInstallerFiles: [
      path.join(root, 'scripts', 'setup-team-retouch-advanced.ps1'),
      path.join(root, 'scripts', 'uninstall-team-retouch-advanced.ps1'),
    ],
    pyInstallerArgs: [
      '--collect-binaries', 'onnxruntime',
      '--paths', path.join(root, 'extensions', 'team-retouch'),
      '--hidden-import', 'patch_merge', '--hidden-import', 'advanced_bridge', '--hidden-import', 'identity_engine',
      '--exclude-module', 'scipy', '--exclude-module', 'matplotlib',
      '--exclude-module', 'torch', '--exclude-module', 'torchvision', '--exclude-module', 'torchaudio',
    ],
    requiresOpenCv: true,
  },
};

const inspectOpenCvEnvironment = () => {
  const script = [
    'import importlib.metadata as metadata, json, pathlib, cv2',
    'packages = sorted({dist.metadata.get("Name", "").lower() for dist in metadata.distributions() if dist.metadata.get("Name", "").lower().startswith("opencv-")})',
    'dlls = sorted(path.name for path in pathlib.Path(cv2.__file__).parent.glob("opencv_videoio_ffmpeg*_64.dll"))',
    'print(json.dumps({"packages": packages, "dlls": dlls}))',
  ].join('; ');
  const result = spawnSync(python, ['-c', script], { cwd: root, encoding: 'utf8' });
  if ((result.status ?? 1) !== 0) throw new Error(result.stderr?.trim() || 'OpenCV build environment probe failed');
  const state = JSON.parse(result.stdout.trim());
  const dllsAreClean = process.platform !== 'win32' || state.dlls.length === 1;
  if (state.packages.length !== 1 || state.packages[0] !== 'opencv-python-headless' || !dllsAreClean) {
    throw new Error(`OpenCV build environment is not clean: packages=${state.packages.join(',') || 'none'}, dlls=${state.dlls.join(',') || 'none'}. Recreate the environment or run npm run setup:team-retouch.`);
  }
};

const probeModule = moduleName => {
  const result = spawnSync(python, ['-c', `import ${moduleName}`], { cwd: root, encoding: 'utf8' });
  return (result.status ?? 1) === 0;
};

const hasDirectML = () => {
  const result = spawnSync(python, ['-c', 'import onnxruntime as ort; raise SystemExit(0 if "DmlExecutionProvider" in ort.get_available_providers() else 1)'], { cwd: root, encoding: 'utf8' });
  return (result.status ?? 1) === 0;
};

const packageComponent = id => {
  const componentRoot = path.join(outputRoot, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(componentRoot, 'component.json'), 'utf8'));
  const artifactName = `PhotoFlow-${id}-${manifest.version}-${process.platform}-${process.arch}.zip`;
  const artifactPath = path.join(releaseRoot, artifactName);
  const artifactPrefix = `PhotoFlow-${id}-`;
  const artifactSuffix = `-${process.platform}-${process.arch}.zip`;
  for (const existingName of fs.readdirSync(releaseRoot)) {
    if (existingName.startsWith(artifactPrefix) && existingName.endsWith(artifactSuffix) && existingName !== artifactName) {
      fs.rmSync(path.join(releaseRoot, existingName), { force: true });
    }
  }
  const script = [
    'import pathlib, sys, zipfile',
    'source, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])',
    'target.unlink(missing_ok=True)',
    'with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:',
    '    for item in sorted(source.rglob("*")):',
    '        if item.is_file(): archive.write(item, pathlib.Path(source.name) / item.relative_to(source))',
  ].join('\n');
  const result = spawnSync(python, ['-c', script, componentRoot, artifactPath], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`${id} package failed with code ${result.status}`);
  console.log(`Component package ready: ${artifactPath}`);
};

const build = id => {
  const definition = definitions[id];
  if (!definition) throw new Error(`Unknown component: ${id}`);
  if (!fs.existsSync(definition.source) || !fs.existsSync(definition.template)) throw new Error(`Component source is incomplete: ${id}`);
  for (const model of definition.models || []) {
    const modelPath = typeof model === 'string' ? model : model.path;
    const minBytes = typeof model === 'string' ? 1024 * 1024 : model.minBytes;
    if (!fs.existsSync(modelPath)) throw new Error(`Team-retouch model is missing: ${modelPath}\nSee extensions/team-retouch/MODEL-SOURCE.md`);
    const stat = fs.statSync(modelPath);
    const prefix = fs.readFileSync(modelPath).subarray(0, 256).toString('utf8');
    if (stat.size < minBytes || prefix.startsWith('version https://git-lfs.github.com/spec/v1')) {
      throw new Error(`Team-retouch model is a Git LFS pointer or incomplete: ${modelPath}\nRun git lfs pull before building.`);
    }
  }
  for (const script of definition.advancedScripts || []) {
    if (!fs.existsSync(script)) throw new Error(`Team-retouch advanced script is missing: ${script}`);
  }
  for (const installerFile of definition.advancedInstallerFiles || []) {
    if (!fs.existsSync(installerFile)) throw new Error(`Team-retouch advanced installer file is missing: ${installerFile}`);
  }
  if (id === 'team-retouch' && !probeModule('onnxruntime')) {
    throw new Error('onnxruntime-directml is not installed in the component build environment');
  }
  for (const moduleName of definition.requiredModules || []) {
    if (!probeModule(moduleName)) throw new Error(`${moduleName} is not installed in the component build environment`);
  }
  if (id === 'team-retouch' && !hasDirectML()) {
    throw new Error('The component build environment has ONNX Runtime, but not the DirectML execution provider');
  }
  if (definition.requiresOpenCv) inspectOpenCvEnvironment();

  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(path.join(pythonBuildRoot, 'specs', 'components'), { recursive: true });
  const target = path.join(outputRoot, id);
  const relativeTarget = path.relative(outputRoot, target);
  if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error(`Unsafe component output path: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  const dataSeparator = process.platform === 'win32' ? ';' : ':';
  const modelArgs = (definition.models || []).flatMap(model => ['--add-data', `${typeof model === 'string' ? model : model.path}${dataSeparator}models`]);
  const advancedArgs = (definition.advancedScripts || []).flatMap(script => ['--add-data', `${script}${dataSeparator}advanced`]);
  const result = spawnSync(python, [
    '-m', 'PyInstaller', '--onedir', '--clean', '--noconfirm',
    '--specpath', path.join(pythonBuildRoot, 'specs', 'components'),
    '--workpath', path.join(pythonBuildRoot, 'pyinstaller-components', id),
    '--distpath', outputRoot,
    '--name', id,
    ...definition.pyInstallerArgs,
    ...modelArgs,
    ...advancedArgs,
    definition.source,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`${id} build failed with code ${result.status}`);
  if (definition.advancedInstallerFiles?.length) {
    const installerRoot = path.join(target, 'advanced-installer');
    fs.mkdirSync(installerRoot, { recursive: true });
    for (const installerFile of definition.advancedInstallerFiles) {
      fs.copyFileSync(installerFile, path.join(installerRoot, path.basename(installerFile)));
    }
  }
  fs.copyFileSync(definition.template, path.join(target, 'component.json'));
  console.log(`Component ready: ${target}`);
  packageComponent(id);
};

try {
  for (const id of componentIds) build(id);
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
