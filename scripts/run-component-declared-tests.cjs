const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
const declaredTests = ({ root, suite }) => {
  if (!suite || !/^[a-z][a-z0-9-]*$/.test(suite)) throw new Error('A valid declared component test suite is required');
  const extensionsRoot = path.join(root, 'extensions');
  const declarations = fs.existsSync(extensionsRoot) ? fs.readdirSync(extensionsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(extensionsRoot, entry.name, 'package.json')).filter(file => fs.existsSync(file)).map(file => ({ file, packageRoot: path.dirname(file), manifest: JSON.parse(fs.readFileSync(file, 'utf8')) })) : [];
  const result = [];
  for (const declaration of declarations) {
    const tests = declaration.manifest.photoflowComponent?.tests?.[suite] ?? [];
    if (!Array.isArray(tests) || tests.length > 16 || new Set(tests).size !== tests.length || tests.some(test => typeof test !== 'string' || !test || test !== test.trim() || test.length > 256 || path.isAbsolute(test) || !/\.(?:cjs|mjs)$/.test(test))) throw new Error(`Invalid photoflowComponent.tests.${suite} declaration in ${declaration.file}`);
    if (fs.lstatSync(declaration.packageRoot).isSymbolicLink()) throw new Error(`Component package root cannot be linked: ${declaration.packageRoot}`);
    const realPackageRoot = fs.realpathSync(declaration.packageRoot);
    for (const relativePath of tests) {
      const testPath = path.resolve(declaration.packageRoot, relativePath);
      if (!inside(declaration.packageRoot, testPath)) throw new Error(`Component test escapes its package: ${relativePath}`);
      let cursor = testPath;
      while (cursor !== declaration.packageRoot) { const stat = fs.lstatSync(cursor, { throwIfNoEntry: false }); if (!stat) throw new Error(`Declared component test is missing: ${testPath}`); if (stat.isSymbolicLink()) throw new Error(`Declared component test uses a linked path: ${testPath}`); cursor = path.dirname(cursor); }
      const realTestPath = fs.realpathSync(testPath);
      if (!inside(realPackageRoot, realTestPath) || !fs.lstatSync(testPath).isFile()) throw new Error(`Declared component test is not a safe package file: ${testPath}`);
      result.push({ packageRoot: declaration.packageRoot, testPath });
    }
  }
  return result;
};
const run = ({ root = path.resolve(__dirname, '..'), suite = process.argv[2] } = {}) => {
  const tests = declaredTests({ root, suite });
  for (const test of tests) { const child = spawnSync(process.execPath, [test.testPath], { cwd: test.packageRoot, stdio: 'inherit', env: { ...process.env } }); if (child.error) throw child.error; if ((child.status ?? 1) !== 0) process.exit(child.status ?? 1); }
  console.log(`Declared component ${suite} tests passed (${tests.length} files).`);
};
if (require.main === module) run();
module.exports = { declaredTests, run };
