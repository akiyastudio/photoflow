const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const installer = fs.readFileSync(path.join(repositoryRoot, 'packaging', 'installer.nsh'), 'utf8');
const privacyService = fs.readFileSync(path.join(repositoryRoot, 'electron', 'privacy-service.cjs'), 'utf8');

assert.strictEqual(packageJson.build.nsis.license, 'docs/legal/INSTALLER_TERMS.txt');
assert.strictEqual(packageJson.build.nsis.oneClick, false);
assert.strictEqual(packageJson.build.nsis.perMachine, true);
assert(packageJson.scripts['electron:build'].includes('npm run generate:installer-terms'));

const text = fs.readFileSync(path.join(repositoryRoot, packageJson.build.nsis.license));
assert.deepStrictEqual([...text.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
const decoded = text.toString('utf8');
for (const required of [
  '照片流安装条款与隐私说明',
  '照片流用户协议及内测条款',
  '照片流隐私政策（内测版）',
  '只有明确接受后，安装程序才会继续',
  '实际使用前仍会另行展示规则并取得单独同意',
]) assert(decoded.includes(required), `installer terms must contain: ${required}`);

const html = fs.readFileSync(path.join(repositoryRoot, 'docs', 'legal', 'INSTALLER_TERMS.html'), 'utf8');
assert(html.startsWith('<!doctype html>') && html.includes('<meta charset="utf-8">'));
assert(installer.includes('IfSilent PhotoFlowSkipConsentReceipt'));
assert(installer.includes('WriteINIStr "$APPDATA\\Photoflow\\install-consent.ini"'));
const termsVersion = privacyService.match(/CURRENT_TERMS_VERSION = '([^']+)'/)?.[1];
const privacyVersion = privacyService.match(/CURRENT_PRIVACY_NOTICE_VERSION = '([^']+)'/)?.[1];
assert(installer.includes(`!define PhotoFlowTermsVersion "${termsVersion}"`));
assert(installer.includes(`!define PhotoFlowPrivacyVersion "${privacyVersion}"`));

console.log('Installer terms tests passed');
