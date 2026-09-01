const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const checkProject = fs.readFileSync(path.join(root, 'scripts', 'check-project.cjs'), 'utf8');
const privacyScript = String(packageJson.scripts?.['test:privacy'] || '');
const legalScriptName = 'test:legal-release-evidence';
const legalScriptCommand = 'node scripts/test-legal-release-evidence.cjs';
const legalStepRemoval = /[ \t]*\['legal release evidence',\s*\['run',\s*'test:legal-release-evidence'\]\],?\r?\n?/;
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
  const legalStep = /\['legal release evidence',\s*\['run',\s*'test:legal-release-evidence'\]\]/g;
  assert.equal([...checkProjectSource.matchAll(legalStep)].length, 1, 'default check-project steps must invoke npm run test:legal-release-evidence exactly once');
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
  /default check-project steps must invoke npm run test:legal-release-evidence exactly once/,
  'removing the legal default step must fail the default-gate contract',
);
assert.equal(checkProject.includes("['run', 'check']"), false, 'check-project must not recursively invoke itself');

console.log('Privacy and legal default-gate contract tests passed');
