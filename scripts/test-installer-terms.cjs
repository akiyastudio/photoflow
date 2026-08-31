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
assert.strictEqual(decoded.includes('\r\r\n'), false, 'installer terms must use canonical CRLF line endings');
for (const required of [
  '照片流安装条款与隐私说明',
  '照片流用户协议及公测条款',
  '照片流隐私政策（公测版）',
  '只有明确接受后，安装程序才会继续',
  '用户体验改善计划为自愿参加',
  '不勾选不会阻止安装',
  '实际使用前仍会另行展示规则并取得单独同意',
]) assert(decoded.includes(required), `installer terms must contain: ${required}`);

const html = fs.readFileSync(path.join(repositoryRoot, 'docs', 'legal', 'INSTALLER_TERMS.html'), 'utf8');
assert(html.startsWith('<!doctype html>') && html.includes('<meta charset="utf-8">'));
assert(installer.includes('IfSilent PhotoFlowSkipConsentReceipt'));
assert(installer.includes('WriteINIStr "$APPDATA\\Photoflow\\install-consent.ini"'));
assert(installer.includes('WriteINIStr "$INSTDIR\\resources\\install-consent.ini"'));
assert(installer.includes('我愿意加入用户体验改善计划'));
assert(installer.includes('!define MUI_LICENSEPAGE_CHECKBOX'));
assert(installer.includes('!define MUI_LICENSEPAGE_BUTTON "我同意"'));
assert(installer.includes('如果你接受协议中的条款，请单击 [我同意] 继续安装。'));
assert(installer.includes('FindWindow $PhotoFlowLicensePage "#32770" "" $HWNDPARENT'));
assert(installer.includes('GetDlgItem $PhotoFlowNativeConsentControl $PhotoFlowLicensePage 1034'));
assert(installer.includes('GetDlgItem $PhotoFlowExperienceProgramCheckbox $PhotoFlowLicensePage 1201'));
assert(installer.includes('StrCpy $PhotoFlowExperienceProgram ${BST_CHECKED}'));
assert(installer.includes('CreateWindowExW'));
assert(installer.includes('ShowWindow $PhotoFlowNativeConsentControl ${SW_HIDE}'));
assert(installer.includes('"ExperienceProgram" "1"'));
assert(installer.includes('"ExperienceProgram" "0"'));
const termsVersion = privacyService.match(/CURRENT_TERMS_VERSION = '([^']+)'/)?.[1];
const privacyVersion = privacyService.match(/CURRENT_PRIVACY_NOTICE_VERSION = '([^']+)'/)?.[1];
assert(installer.includes(`!define PhotoFlowTermsVersion "${termsVersion}"`));
assert(installer.includes(`!define PhotoFlowPrivacyVersion "${privacyVersion}"`));

console.log('Installer terms tests passed');
