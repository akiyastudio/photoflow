const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CURRENT_PRIVACY_NOTICE_VERSION,
  CURRENT_TERMS_VERSION,
  INSTALL_CONSENT_FILE_NAME,
  createPrivacyService,
} = require('../electron/privacy-service.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-privacy-test-'));
const localTimestamp = date => {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
const writeReceipt = (userData, acceptedAt, overrides = {}) => {
  fs.mkdirSync(userData, { recursive: true });
  const values = {
    SchemaVersion: '2',
    Interactive: '1',
    TermsVersion: CURRENT_TERMS_VERSION,
    PrivacyVersion: CURRENT_PRIVACY_NOTICE_VERSION,
    InstallerVersion: '26.7.31',
    AcceptedAtLocal: localTimestamp(acceptedAt),
    ExperienceProgram: '0',
    ...overrides,
  };
  fs.writeFileSync(path.join(userData, INSTALL_CONSENT_FILE_NAME), `[Consent]\n${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, 'utf8');
};
const serviceFor = (name, options = {}) => {
  const userData = path.join(sandbox, name);
  const clock = options.clock || { value: new Date('2026-08-02T08:00:00.000Z') };
  const service = createPrivacyService({
    app: { isPackaged: options.isPackaged !== false, getPath: key => key === 'userData' ? userData : sandbox },
    fs,
    path,
    shell: { openPath: async () => '' },
    projectRoot: path.resolve(__dirname, '..'),
    now: () => new Date(clock.value),
    platform: 'win32',
  });
  return { userData, service, clock };
};

(async () => {
try {
  const installed = serviceFor('installed');
  const acceptedAt = new Date(installed.clock.value.getTime() - 60_000);
  writeReceipt(installed.userData, acceptedAt);
  const imported = installed.service.getState();
  assert.strictEqual(imported.privacyNoticeVersion, CURRENT_PRIVACY_NOTICE_VERSION);
  assert.strictEqual(imported.termsVersion, CURRENT_TERMS_VERSION);
  assert.strictEqual(installed.service.hasCoreConsent(), true);
  const importedFile = JSON.parse(fs.readFileSync(path.join(installed.userData, 'privacy-consent.json'), 'utf8'));
  assert.strictEqual(importedFile.coreConsentSource, 'interactive-installer');
  assert.strictEqual(importedFile.installerVersion, '26.7.31');
  assert.strictEqual(imported.experienceProgramGranted, false);

  const optedIn = serviceFor('opted-in');
  writeReceipt(optedIn.userData, new Date(optedIn.clock.value.getTime() - 60_000), { ExperienceProgram: '1' });
  assert.strictEqual(optedIn.service.getState().experienceProgramGranted, true, 'installer experience program choice must be imported independently');

  const applicationOnly = serviceFor('application-only');
  await applicationOnly.service.saveConsent({ acceptCore: true, experienceProgramGranted: false });
  assert.strictEqual(applicationOnly.service.hasCoreConsent(), true, 'core terms can be accepted without joining the experience program');
  assert.strictEqual(applicationOnly.service.getState().experienceProgramGranted, false);

  await installed.service.saveConsent({ revokeCore: true });
  assert.strictEqual(installed.service.hasCoreConsent(), false, 'an old installer receipt must not undo an application withdrawal');
  const revoked = JSON.parse(fs.readFileSync(path.join(installed.userData, 'privacy-consent.json'), 'utf8'));
  assert(revoked.coreConsentRevokedAt, 'withdrawal must be timestamped');

  const reinstalledAt = new Date(installed.clock.value.getTime() + 60_000);
  installed.clock.value = new Date(installed.clock.value.getTime() + 120_000);
  writeReceipt(installed.userData, reinstalledAt, { InstallerVersion: '26.8.1' });
  assert.strictEqual(installed.service.hasCoreConsent(), true, 'a later interactive reinstall may establish fresh consent');

  const silent = serviceFor('silent');
  writeReceipt(silent.userData, new Date(silent.clock.value.getTime() - 60_000), { Interactive: '0' });
  assert.strictEqual(silent.service.hasCoreConsent(), false, 'silent installs must fall back to application consent');

  const outdated = serviceFor('outdated');
  writeReceipt(outdated.userData, new Date(outdated.clock.value.getTime() - 60_000), { PrivacyVersion: '2026-01-01' });
  assert.strictEqual(outdated.service.hasCoreConsent(), false, 'outdated installer terms must not satisfy current consent');

  const development = serviceFor('development', { isPackaged: false });
  writeReceipt(development.userData, new Date(development.clock.value.getTime() - 60_000));
  assert.strictEqual(development.service.hasCoreConsent(), false, 'development launches must not consume an installed application receipt');

  console.log('Privacy service installer consent tests passed');
} finally {
  const resolved = path.resolve(sandbox);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(resolved, { recursive: true, force: true });
}
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
