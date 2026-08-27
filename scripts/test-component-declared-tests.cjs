const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { declaredTests } = require('./run-component-declared-tests.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-declared-tests-')); const componentRoot = path.join(root, 'extensions', 'fixture'); const testRoot = path.join(componentRoot, 'tests');
fs.mkdirSync(testRoot, { recursive: true }); fs.writeFileSync(path.join(testRoot, 'layout.cjs'), '');
const write = tests => fs.writeFileSync(path.join(componentRoot, 'package.json'), JSON.stringify({ photoflowComponent: { tests: { fixture: tests } } }));
try {
  write(['tests/layout.cjs']); assert.equal(declaredTests({ root, suite: 'fixture' }).length, 1);
  for (const invalid of [['../outside.cjs'], ['tests/layout.js'], ['tests/layout.cjs', 'tests/layout.cjs'], Array.from({ length: 17 }, (_unused, index) => `tests/${index}.cjs`)]) { write(invalid); assert.throws(() => declaredTests({ root, suite: 'fixture' }), /Invalid|escapes/); }
  const outside = path.join(root, 'outside.cjs'); fs.writeFileSync(outside, ''); let linked = false; try { fs.symlinkSync(outside, path.join(testRoot, 'linked.cjs'), 'file'); linked = true; } catch { /* Windows may deny symlink creation. */ }
  if (linked) { write(['tests/linked.cjs']); assert.throws(() => declaredTests({ root, suite: 'fixture' }), /linked path/); }
  console.log('Declared component test discovery safety tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
