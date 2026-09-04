const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const setupPath = path.join(root, 'advanced-installer', 'setup-team-retouch-advanced.ps1');
const uninstallPath = path.join(root, 'advanced-installer', 'uninstall-team-retouch-advanced.ps1');
const setup = fs.readFileSync(setupPath, 'utf8');
const uninstall = fs.readFileSync(uninstallPath, 'utf8');
const service = fs.readFileSync(path.join(root, 'service.cjs'), 'utf8');
const packaging = fs.readFileSync(path.join(root, 'scripts', 'package-component.cjs'), 'utf8');

for (const scriptPath of [setupPath, uninstallPath]) {
  const escaped = scriptPath.replaceAll("'", "''");
  const parsed = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$null,[ref]$errors); if($errors.Count){$errors|% Message; exit 1}`], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, `PowerShell parser rejected ${path.basename(scriptPath)}:\n${parsed.stdout}\n${parsed.stderr}`);
}

assert.doesNotMatch(setup, /PHOTOFLOW_COMPONENT_ADVANCED_PACKAGE_SHA256/);
assert.doesNotMatch(setup, /\$ExpectedPackageSha256 = \$declaredPackageSha256/);
assert.match(setup, /FileShare\]::Read, 8MB/);
assert.match(setup, /ZipArchive\]::new\(\$packageStream/);
assert.match(setup, /Copy-ValidatedVhdEntry/);
assert.match(setup, /Installed component root must not be a reparse point/);
assert.match(setup, /Installed component manifest escaped the component root/);
assert.match(setup, /Assert-RegistrationBasePath \$DistroName \$InstallRoot/);
assert.match(setup, /Repair refused: install-state and ownership marker do not bind this distribution/);
assert.match(setup, /--import-in-place \$candidateName/);
assert.match(setup, /Test-Distro \$candidateName/);
assert.doesNotMatch(setup, /CompatibleLegacyComponentVersions|legacyPackage|Get-ChildItem[^\n]*(?:\.vhdx|\.json)|PathType Container/);
assert.match(uninstall, /ownership marker/);
assert.match(packaging, /process\.argv\.includes\('--with-advanced'\)/);
assert.match(packaging, /offlinePackage=\{path:advancedPackageName,sha256:/);
assert.match(packaging, /ZIP_STORED if item\.suffix\.lower\(\)=="\.zip"/);
assert.match(setup, /\$candidateRegistered = \[bool\]\(Get-DistroRegistration \$candidateName\)/);
assert.match(setup, /Rollback failed; recovery VHD was preserved/);
for (const point of ['candidate-copy','candidate-import','candidate-probe','backup','old-unregister','final-copy','final-import','final-probe','state-write']) assert(setup.includes(`Invoke-TestFault '${point}'`), `installer fault point missing: ${point}`);
assert.match(setup, /-not \$registration -and -not \$preserveBackup/);
for (const digest of [
  '6041dded9177d5bd0bca9e3aa264ceb99ec1ff7b0d53320d2433587704840fca',
  '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  '6b6a35772fb636cdd4fa86520c1a259d0c41472a76f70f802b351837a00d9870',
  '7f545cff27644dcc7481d53b2f6df0b4ba22ceff71f1a839c83a1be5c0973eae',
]) assert(packaging.includes(digest), `fixed model digest missing: ${digest}`);

const suggestStart = service.indexOf('const suggestIdentities');
const suggestEnd = service.indexOf('const saveWorkflowSettings', suggestStart);
const suggest = service.slice(suggestStart, suggestEnd);
assert.match(suggest, /path: sourceByPhoto/);
assert.match(suggest, /manualIdentityId:/);
assert.doesNotMatch(suggest, /sourcePath: sourceByPhoto/);
assert.match(service, /const deletePatch = \(parentId, payload, context\)/);
assert.match(service, /projectOperationKey\(context, operationId\)/);
assert.match(service, /MAX_DATABASE_CACHE_ENTRIES = 8/);
assert.match(service, /closeDatabaseCachesForRestore/);
assert.match(service, /fs\.appendFileSync\(path\.join\(directory, 'operations\.ndjson'\)/);
assert.match(service, /stagePrefix.*ownerToken/);
console.log('Team-retouch advanced trust and cross-layer contract tests passed');
