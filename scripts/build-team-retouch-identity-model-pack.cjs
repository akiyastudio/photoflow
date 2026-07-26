const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PLUGIN_DEFINITIONS } = require('../electron/plugins/plugin-catalog.cjs');

const root = path.resolve(__dirname, '..');
const version = PLUGIN_DEFINITIONS['team-retouch'].version;
const sourceModels = [
  {
    id: 'adaface-ir18',
    fileName: 'adaface_ir18_webface4m.onnx',
    source: path.join(root, '.model-lab', 'adaface', 'adaface_ir18_webface4m.onnx'),
    minBytes: 80 * 1024 * 1024,
    upstream: 'https://github.com/mk-minchul/AdaFace',
    license: 'MIT',
  },
  {
    id: 'osnet-x1',
    fileName: 'osnet_x1_0_msmt17.onnx',
    source: path.join(root, '.model-lab', 'osnet', 'osnet_x1_0_msmt17.onnx'),
    minBytes: 7 * 1024 * 1024,
    upstream: 'https://huggingface.co/kaiyangzhou/osnet',
    license: 'MIT',
  },
];
const releaseRoot = path.join(root, 'release');
const outputRoot = path.join(releaseRoot, 'model-packs', 'team-retouch-identity-models');
const artifactPath = path.join(releaseRoot, `PhotoFlow-team-retouch-identity-models-${version}-${process.platform}-${process.arch}.zip`);

const sha256 = filePath => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

for (const model of sourceModels) {
  const stat = fs.statSync(model.source, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size < model.minBytes) {
    throw new Error(`Prepared model is missing or incomplete: ${model.source}`);
  }
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });
const manifestModels = sourceModels.map(model => {
  const destination = path.join(outputRoot, model.fileName);
  fs.copyFileSync(model.source, destination);
  return {
    id: model.id,
    file: model.fileName,
    sizeBytes: fs.statSync(destination).size,
    sha256: sha256(destination),
    upstream: model.upstream,
    license: model.license,
  };
});

const manifest = {
  formatVersion: 1,
  id: 'team-retouch-identity-models',
  version,
  componentId: 'team-retouch',
  platforms: ['win32'],
  architectures: ['x64'],
  componentDirectory: '%LOCALAPPDATA%\\PhotoFlow\\components\\team-retouch',
  models: manifestModels,
};
fs.writeFileSync(path.join(outputRoot, 'model-pack.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const adafaceLicense = path.join(root, '.model-lab', 'adaface', 'source', 'AdaFace-master', 'LICENSE');
if (!fs.existsSync(adafaceLicense)) throw new Error(`AdaFace license is missing: ${adafaceLicense}`);
fs.copyFileSync(adafaceLicense, path.join(outputRoot, 'LICENSE-AdaFace.txt'));
fs.writeFileSync(path.join(outputRoot, 'LICENSE-OSNet.txt'), `MIT License

Copyright (c) 2018 Kaiyang Zhou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`, 'utf8');
fs.writeFileSync(path.join(outputRoot, 'README-install.txt'), `PhotoFlow 多人修脸增强人物识别模型包

1. 在 PhotoFlow 中打开“设置 → 多人修脸 → 打开目录”。
2. 把本 ZIP 原样放入该目录，不需要解压。
3. 返回“设置 → 多人修脸”，点击增强人物识别模型的安装按钮。

多人修脸组件目录：%LOCALAPPDATA%\\PhotoFlow\\components\\team-retouch
`, 'utf8');

const python = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');
const pythonCommand = fs.existsSync(python) ? python : 'python';
const zipScript = [
  'import pathlib, sys, zipfile',
  'source, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])',
  'target.unlink(missing_ok=True)',
  'with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:',
  '    for item in sorted(source.iterdir()):',
  '        if item.is_file(): archive.write(item, item.name)',
].join('\n');
const result = spawnSync(pythonCommand, ['-c', zipScript, outputRoot, artifactPath], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) throw new Error(`Identity model package failed with code ${result.status}`);

console.log(`Identity model package ready: ${artifactPath}`);
console.log(`SHA256: ${sha256(artifactPath)}`);
