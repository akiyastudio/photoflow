const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const checkProject = fs.readFileSync(path.join(root, 'scripts', 'check-project.cjs'), 'utf8');
const privacyScript = String(packageJson.scripts?.['test:privacy'] || '');
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
assert.equal(checkProject.includes("['run', 'check']"), false, 'check-project must not recursively invoke itself');

console.log('Privacy default-gate contract tests passed');
