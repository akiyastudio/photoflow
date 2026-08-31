const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'src/features/settings/SettingsFeature.tsx'), 'utf8');
const onboarding = fs.readFileSync(path.join(root, 'src/features/settings/UsagePreferencesOnboarding.tsx'), 'utf8');
const dialogs = fs.readFileSync(path.join(root, 'src/components/AppDialogProvider.tsx'), 'utf8');
const privacyConsent = fs.readFileSync(path.join(root, 'src/utils/privacyConsent.ts'), 'utf8');

assert.match(settings, /createSettingsSaveCoordinator/, 'settings saves use the serial coordinator');
assert.match(settings, /const patchSettings = [^\n]*draftRef\.current/, 'field patches are based on the latest draft ref');
assert.doesNotMatch(settings, /commitSettings\(\{ \.\.\.draft/, 'callbacks never rebuild a save from a render-time draft');
assert.match(settings, /backupRequestRef/, 'backup refreshes reject stale async responses');
assert.match(settings, /setBackupAction\('cleanup'\)/, 'backup cleanup participates in action mutual exclusion');
assert.match(settings, /catch[\s\S]{0,200}setSubmitting\(false\)/, 'feedback failures release the submitting state');
assert.match(onboarding, /try[\s\S]{0,400}catch[\s\S]{0,300}finally/, 'onboarding save is retryable after rejection');
assert.match(onboarding, /savingRef\.current/, 'onboarding synchronously rejects same-tick duplicate saves');
assert.match(dialogs, /previousFocusRef/, 'dialogs restore focus to the invoking control');
assert.match(dialogs, /dangerousConfirm[\s\S]{0,500}data-default-focus/, 'dangerous confirmation does not receive the default focus');
assert.match(privacyConsent, /inFlightConsentRef|consentRequests/, 'face consent calls are coalesced');

console.log('Settings UI resilience contracts passed');
