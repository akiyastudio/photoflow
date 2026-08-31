const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'src/features/settings/SettingsFeature.tsx'), 'utf8');
const onboarding = fs.readFileSync(path.join(root, 'src/features/settings/UsagePreferencesOnboarding.tsx'), 'utf8');
const dialogs = fs.readFileSync(path.join(root, 'src/components/AppDialogProvider.tsx'), 'utf8');
const privacyConsent = fs.readFileSync(path.join(root, 'src/utils/privacyConsent.ts'), 'utf8');

assert.match(settings, /createSettingsSaveCoordinator/, 'settings saves use the serial coordinator');
assert.match(settings, /enqueueMutation\(current => patchSettingsDraft\(current, patch\)\)/, 'ordinary UI saves enqueue change intent instead of a captured full snapshot');
assert.doesNotMatch(settings, /const saveNas[\s\S]*?const base = draftRef\.current[\s\S]*?saveNasCredential/, 'NAS credential awaits never retain a complete pre-await draft');
assert.match(settings, /saveNasCredential[\s\S]*?const latestForTesting = draftRef\.current[\s\S]*?saveConfig\(testingConfig\)/, 'NAS testing snapshot is assembled from the latest draft immediately before saving');
assert.doesNotMatch(settings, /const patchSettings = [^\n]*draftRef\.current/, 'ordinary settings do not capture a full optimistic draft snapshot');
assert.doesNotMatch(settings, /commitSettings\(\{ \.\.\.draft/, 'callbacks never rebuild a save from a render-time draft');
assert.match(settings, /backupRequestRef/, 'backup refreshes reject stale async responses');
assert.match(settings, /setBackupAction\('cleanup'\)/, 'backup cleanup participates in action mutual exclusion');
assert.match(settings, /const cleanupBackup[\s\S]*?drainSettingsBeforeBackupAction\('备份清理'\)[\s\S]*?electronAPI\.cleanupBackup/, 'backup cleanup waits for pending settings saves');
assert.match(settings, /const runBackup[\s\S]*?drainSettingsBeforeBackupAction\('立即备份'\)[\s\S]*?electronAPI\.runBackup/, 'manual backup waits for pending settings saves');
assert.match(settings, /const verifyBackup[\s\S]*?drainSettingsBeforeBackupAction\('备份验证'\)[\s\S]*?electronAPI\.verifyBackup/, 'backup verification waits for pending settings saves');
assert.match(settings, /const restoreWorkspace[\s\S]*?drainSettingsBeforeBackupAction\('工作区恢复'\)[\s\S]*?transaction\(async \(_saveConfig, adoptConfig\)[\s\S]*?adoptConfig\(next\)/, 'workspace restore drains first and adopts its external persisted revision inside the save queue');
assert.match(settings, /result\.status === 'save-failed'[\s\S]*?待保存的设置保存失败/, 'dependent backup actions report a failed pending save');
assert.match(settings, /result\.status === 'changed'[\s\S]*?等待保存期间设置又有更改/, 'dependent backup actions distinguish a newer edit from save failure');
assert.match(settings, /catch[\s\S]{0,200}setSubmitting\(false\)/, 'feedback failures release the submitting state');
assert.match(onboarding, /try[\s\S]{0,400}catch[\s\S]{0,300}finally/, 'onboarding save is retryable after rejection');
assert.match(onboarding, /savingRef\.current/, 'onboarding synchronously rejects same-tick duplicate saves');
assert.match(dialogs, /previousFocusRef/, 'dialogs restore focus to the invoking control');
assert.match(dialogs, /dangerousConfirm[\s\S]{0,500}data-default-focus/, 'dangerous confirmation does not receive the default focus');
assert.match(privacyConsent, /inFlightConsentRef|consentRequests/, 'face consent calls are coalesced');

console.log('Settings UI resilience contracts passed');
