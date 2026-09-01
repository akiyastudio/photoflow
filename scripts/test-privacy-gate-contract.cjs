const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const checkProject = fs.readFileSync(path.join(root, 'scripts', 'check-project.cjs'), 'utf8');
const publishRelease = fs.readFileSync(path.join(root, 'scripts', 'publish-release.cjs'), 'utf8');
const generateReleaseJson = fs.readFileSync(path.join(root, 'scripts', 'generate-release-json.cjs'), 'utf8');
const privacyScript = String(packageJson.scripts?.['test:privacy'] || '');
const legalScriptName = 'test:legal-release-evidence';
const legalScriptCommand = 'node scripts/test-legal-release-evidence.cjs';
const strictLegalScriptName = 'check:legal-release-ready';
const strictLegalScriptCommand = 'node scripts/test-legal-release-evidence.cjs --require-ready';
const legalStepRemoval = /[ \t]*\['法律证据结构',\s*\['run',\s*'test:legal-release-evidence'\]\],?\r?\n?/;
const requiredPrivacyTests = [
  'scripts/test-privacy-gate-contract.cjs',
  'scripts/test-privacy-service.cjs',
  'scripts/test-telemetry-consent.cjs',
  'scripts/test-privacy-revoke-telemetry.cjs',
];

for (const testPath of requiredPrivacyTests) {
  assert.equal(privacyScript.split(testPath).length - 1, 1, `test:privacy must invoke ${testPath} exactly once`);
}
assert.equal(/npm\s+run\s+(?:check|test(?::privacy)?)/.test(privacyScript), false, 'test:privacy must not recurse into project or privacy gates');

const privacyStep = /\['privacy consent and telemetry',\s*\['run',\s*'test:privacy'\]\]/g;
assert.equal([...checkProject.matchAll(privacyStep)].length, 1, 'default check-project steps must invoke npm run test:privacy exactly once');

const assertLegalDefaultGate = (scripts, checkProjectSource) => {
  assert.equal(String(scripts?.[legalScriptName] || ''), legalScriptCommand, `${legalScriptName} must use the exact legal evidence command`);
  assert.equal(String(scripts?.[strictLegalScriptName] || ''), strictLegalScriptCommand, `${strictLegalScriptName} must use the exact strict legal approval command`);
  assert.equal(String(scripts?.['check:release'] || ''), 'node scripts/check-project.cjs --release-ready', 'check:release must enable strict release readiness');
  const legalStep = /\['法律证据结构',\s*\['run',\s*'test:legal-release-evidence'\]\]/g;
  assert.equal([...checkProjectSource.matchAll(legalStep)].length, 1, 'default check-project steps must invoke the legal evidence structure check exactly once');
  const strictStep = /\['法律发布批准严格门禁',\s*\['run',\s*'check:legal-release-ready'\]\]/g;
  assert.equal([...checkProjectSource.matchAll(strictStep)].length, 1, 'release-ready check-project mode must contain the strict legal approval gate exactly once');
  assert(checkProjectSource.includes("process.argv.includes('--release-ready')"), 'check-project must expose an explicit release-ready mode');
};

assertLegalDefaultGate(packageJson.scripts, checkProject);
assert.throws(
  () => assertLegalDefaultGate({ ...packageJson.scripts, [legalScriptName]: undefined }, checkProject),
  new RegExp(`${legalScriptName} must use the exact legal evidence command`),
  'removing the legal npm script must fail the default-gate contract',
);
const checkProjectWithoutLegalStep = checkProject.replace(legalStepRemoval, '');
assert.notEqual(checkProjectWithoutLegalStep, checkProject, 'the legal-step negative fixture must remove text on LF and CRLF checkouts');
assert.throws(
  () => assertLegalDefaultGate(packageJson.scripts, checkProjectWithoutLegalStep),
  /default check-project steps must invoke the legal evidence structure check exactly once/,
  'removing the legal default step must fail the default-gate contract',
);
assert.equal(checkProject.includes("['run', 'check']"), false, 'check-project must not recursively invoke itself');
assert(publishRelease.includes('runLegalReleaseReadyGate(installerPath)'), 'publish-release must invoke the strict approval gate for its selected installer');
assert(publishRelease.includes("'--installer', installerPath"), 'publish-release must forward its selected installer to release JSON generation');
assert(generateReleaseJson.includes('const requiresReleaseApproval = shouldPublish || published'), 'published records and network publishing must both require strict approval');
assert(generateReleaseJson.includes('if (requiresReleaseApproval) runLegalReleaseReadyGate(installerPath)'), 'generate-release-json must invoke the strict gate for all publishable records');

console.log('Privacy, legal structure, and strict release-gate contract tests passed');
