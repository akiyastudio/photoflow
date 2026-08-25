const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createComponentHostRegistry } = require('../electron/component-host-contract.cjs');
const { developmentPythonPath } = require('../electron/services/python-environment-service.cjs');

const root = path.resolve(__dirname, '..');
const teamRoot = path.join(root, 'extensions', 'team-retouch');
const python = path.resolve(process.argv[2] || developmentPythonPath(root));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-development-matcher-'));
try {
  assert(fs.statSync(python, { throwIfNoEntry: false })?.isFile(), `development Python is missing: ${python}`);
  assert(!fs.existsSync(path.join(teamRoot, process.platform === 'win32' ? 'team-retouch.exe' : 'team-retouch')), 'the source component fixture must not contain a sibling packaged executable');
  const rendererRoot = path.join(sandbox, 'renderers', 'team-retouch');
  fs.mkdirSync(rendererRoot, { recursive: true });
  fs.writeFileSync(path.join(rendererRoot, 'index.html'), '<!doctype html><title>team-retouch test</title>');
  fs.writeFileSync(path.join(rendererRoot, 'settings.html'), '<!doctype html><title>team-retouch settings test</title>');
  const registry = createComponentHostRegistry({
    roots: [{ source: 'development', path: path.join(root, 'extensions') }],
    developmentRendererRoot: path.join(sandbox, 'renderers'),
    developmentAlgorithmRuntimes: {
      'team-retouch': { command: python, argsPrefix: [path.join(teamRoot, 'team_retouch.py')] },
    },
  });
  const descriptor = registry.resolve('team-retouch');
  assert(descriptor && descriptor.source === 'development', 'the real development template must produce a Host descriptor');
  assert.equal(descriptor.fullPage.entry, path.join(rendererRoot, 'index.html'));
  assert.equal(descriptor.settingsPages[0]?.entry, path.join(rendererRoot, 'settings.html'), 'the development fixture must satisfy the Host API 3 settings renderer entry');
  assert.deepEqual(descriptor.algorithmRuntime, { command: python, argsPrefix: [path.join(teamRoot, 'team_retouch.py')] });

  const manifestPath = path.join(sandbox, 'manifest.json');
  const generator = [
    'import json, pathlib, sys',
    'import numpy as np',
    'from PIL import Image, ImageDraw, ImageEnhance, ImageFilter',
    'root, manifest = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])',
    'candidates = []',
    'for index in range(2):',
    '    rng = np.random.default_rng(900 + index)',
    '    pixels = np.full((240, 360, 3), (55 + index * 65, 80, 130 - index * 30), dtype=np.uint8)',
    '    pixels = np.clip(pixels + rng.integers(0, 45, pixels.shape, dtype=np.uint8), 0, 255).astype(np.uint8)',
    '    image = Image.fromarray(pixels, "RGB")',
    '    draw = ImageDraw.Draw(image)',
    '    draw.ellipse((35 + index * 45, 25, 190 + index * 45, 215), outline="white", width=9)',
    '    draw.rectangle((205 - index * 30, 50 + index * 25, 340, 210), outline=(255, 220, 30), width=12)',
    '    candidate = root / f"candidate-{index}.png"',
    '    image.save(candidate)',
    '    candidates.append({"taskId": f"task-{index}", "photoId": f"photo-{index}", "baseVersionId": f"version-{index}", "personIndex": index + 1, "patchPath": str(candidate)})',
    'returned = []',
    'for return_index, candidate_index in enumerate((1, 0)):',
    '    image = Image.open(candidates[candidate_index]["patchPath"]).resize((330, 220))',
    '    image = ImageEnhance.Brightness(image).enhance(1.08)',
    '    image = ImageEnhance.Color(image).enhance(0.82).filter(ImageFilter.GaussianBlur(0.55))',
    '    target = root / f"hashed-{return_index}.jpg"',
    '    image.save(target, quality=75)',
    '    returned.append({"returnId": f"return-{return_index}", "path": str(target), "sourceName": target.name})',
    'manifest.write_text(json.dumps({"returned": returned, "candidates": candidates}), encoding="utf-8")',
  ].join('\n');
  const generated = spawnSync(python, ['-c', generator, sandbox, manifestPath], { cwd: root, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  const helper = path.join(__dirname, 'test-team-retouch-development-matcher-child.cjs');
  const args = [helper, '--photoflow-algorithm-command', descriptor.algorithmRuntime.command,
    ...descriptor.algorithmRuntime.argsPrefix.flatMap(value => ['--photoflow-algorithm-arg-prefix', value]), '--manifest', manifestPath];
  const matched = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(matched.status, 0, matched.stderr || matched.stdout);
  const result = JSON.parse(matched.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.deepEqual(result.matches.map(item => item.taskId), ['task-1', 'task-0'], 'the real team_retouch.py matcher must recover content order independently of filenames');
  assert(result.matches.every(item => item.confidence === 'high' && item.editEvidence.reallyModified), 'content matches must meet the existing high-confidence safety policy');

  const unavailable = spawnSync(process.execPath, [helper, '--photoflow-algorithm-command', path.join(sandbox, 'missing-python.exe'), '--photoflow-algorithm-arg-prefix', path.join(teamRoot, 'team_retouch.py'), '--manifest', manifestPath], { cwd: root, encoding: 'utf8' });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /团片组件算法不可用/, 'missing algorithms must fail explicitly instead of fabricating review matches');
  console.log('Team-retouch real development Host matcher integration test passed');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
