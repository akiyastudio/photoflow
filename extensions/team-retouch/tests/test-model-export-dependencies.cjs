const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requirements = fs.readFileSync(path.join(root, 'requirements-model-export.txt'), 'utf8');
const declared = new Map(requirements
  .split(/\r?\n/u)
  .map(line => line.split('#', 1)[0].trim())
  .filter(line => line && !line.startsWith('--'))
  .map(line => {
    const match = line.match(/^([A-Za-z0-9_.-]+)==(.+)$/u);
    assert(match, `model export dependency must be exactly pinned: ${line}`);
    return [match[1].toLowerCase(), match[2]];
  }));

assert(declared.has('torch'), 'AdaFace and OSNet exporters require pinned torch');
assert(declared.has('onnx'), 'ONNX serialization requires pinned onnx');
for (const script of ['export-adaface.py', 'export-osnet.py']) {
  const source = fs.readFileSync(path.join(root, 'scripts', script), 'utf8');
  assert.match(source, /^import torch$/mu, `${script} must keep torch declared`);
}
assert.equal(
  /default="osnet_x1_0"/u.test(fs.readFileSync(path.join(root, 'scripts', 'export-osnet.py'), 'utf8')),
  true,
  'the OSNet exporter default must match the packaged x1.0 asset',
);
console.log('Plugin model export dependency declarations passed');
