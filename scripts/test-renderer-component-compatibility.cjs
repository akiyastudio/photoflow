const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '..', 'src', 'compatibility');
  const settings = await import(pathToFileURL(path.join(root, 'component-settings.ts')).href);
  const domains = await import(pathToFileURL(path.join(root, 'component-domains.ts')).href);
  const versions = await import(pathToFileURL(path.join(root, 'version-source.ts')).href);

  const legacyValue = { useGpu: false, oversizeCropMode: 'expand', unknownFutureValue: { keep: true } };
  const migrated = settings.migrateLegacyComponentSettings({ personDetection: legacyValue }, { other: { quality: 90 } });
  assert.deepEqual(migrated.other, { quality: 90 });
  assert.deepEqual(migrated['team-retouch'], legacyValue, 'legacy settings must move losslessly into the opaque component namespace');
  assert.notEqual(migrated['team-retouch'], legacyValue, 'migration must not share a mutable object with the loaded legacy config');
  assert.deepEqual(
    settings.migrateLegacyComponentSettings({ personDetection: legacyValue }, { 'team-retouch': { owned: true } })['team-retouch'],
    { owned: true },
    'a component-owned settings namespace must win over the legacy mirror',
  );
  assert.equal(
    settings.migrateLegacyComponentSettings({ personDetection: legacyValue, componentSettingsRevisions: { 'team-retouch': 4 } }, {})['team-retouch'],
    undefined,
    'a nonzero component settings revision is a tombstone/ownership ledger and prevents legacy settings revival after restart',
  );

  assert.equal(domains.legacyComponentIdForDomain('team-retouch'), 'team-retouch');
  assert.equal(domains.legacyComponentIdForDomain('media'), undefined);
  assert.deepEqual(versions.legacyVersionSourceMetadata({ nodeRole: 'workflow', artifactKind: 'team_workspace' }), {
    category: 'workflow', role: 'component-workspace', displayName: '协作', componentId: 'team-retouch', parentCapability: 'workflow-input',
  });
  assert.equal(versions.legacyVersionSourceMetadata({ nodeRole: 'artifact', artifactKind: 'preview' }), undefined);
  console.log('renderer component compatibility tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
