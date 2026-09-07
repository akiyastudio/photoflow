const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'team-independent-runtime-'));
const packaging = fs.readFileSync(path.join(root, 'scripts/package-component.cjs'), 'utf8');
const assembly = packaging.slice(packaging.indexOf('const advancedPackageName='), packaging.indexOf("fs.writeFileSync(path.join(packageRoot,'component.json')"));
const service = fs.readFileSync(path.join(root, 'service.cjs'), 'utf8');
const descriptor = service.slice(service.indexOf('const packagedAdvancedDescriptor ='), service.indexOf('const OUTPUT_OUTBOX ='));
try {
  // Run the actual assembly section for two successive base releases. There is
  // deliberately no runtime ZIP or advanced release lock in the fixture.
  for (const version of ['26.9.7', '26.9.8']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
    manifest.version = version;
    const packageRoot = path.join(temporary, version);
    fs.mkdirSync(packageRoot);
    vm.runInNewContext(assembly, {
      fs, path, root, packageRoot, manifest, withAdvanced: false,
      advancedPackageVersion: value => value.advancedRuntime.packageVersion,
      advancedPackagePath: name => path.join(temporary, 'absent', name),
      sha256File: file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    });
    assert.equal(manifest.advancedRuntime.offlinePackage, undefined);
    assert.equal(manifest.advancedRuntime.packageVersion, '26.9.4');
    assert.equal(manifest.componentHost.service.lifecycleActions.install.entry, 'advanced-installer/setup-team-retouch-advanced.ps1');
    assert(manifest.componentHost.service.rpcMethods.includes('team.advanced.install.v1'));
    assert(!manifest.requiredFiles.some(file => file.endsWith('.zip')));
    for (const file of ['advanced/pairdetr_service.py', 'advanced/sam2_service.py', 'advanced/locks/checkpoints.sha256']) assert(fs.existsSync(path.join(packageRoot, file)));
    fs.writeFileSync(path.join(packageRoot, 'component.json'), JSON.stringify(manifest));
    const calls = [];
    vm.runInNewContext(`${descriptor}\nif (advancedBuildUnavailable()) throw new Error('Base update disabled runtime'); lifecycleAction('test', 'install');`, {
      fs, path, __dirname: packageRoot, callHost: (...args) => calls.push(args),
    });
    assert.equal(calls[0][1], 'component.lifecycle');
    assert.equal(calls[0][2].action, 'install');
  }
  console.log('Independent runtime: successive base packages retain advanced scripts, probing and installation without an embedded ZIP.');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
