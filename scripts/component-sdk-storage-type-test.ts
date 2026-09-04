import type { ComponentStorageResponse } from '../component-sdk/index.js';

const pending: ComponentStorageResponse = {
   projectId: 'project', ownership: 'component-private',
  adoption: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'pending', componentId: 'sample-component', startedAt: 1 },
};
if (pending.adoption?.state === 'pending') {
  // @ts-expect-error Pending adoption intentionally grants no readable or writable path.
  void pending.dataPath;
}

const committed: ComponentStorageResponse = {
   dataPath: 'private', databasePath: 'private/storage.sqlite3', projectId: 'project', ownership: 'component-private',
  adoption: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'committed', componentId: 'sample-component', adoptedDataRoot: true, adoptedDatabase: true, legacyDataRoot: 'legacy', legacyDatabasePath: 'legacy.sqlite3', databaseSha256: 'digest', copiedFileCount: 2, copiedByteCount: 3 },
};
void committed.dataPath;

// @ts-expect-error A committed receipt must include verification counts, flags, digest, and legacy references.
const incompleteCommitted: ComponentStorageResponse = {  dataPath: 'private', databasePath: 'db', projectId: 'project', ownership: 'component-private', adoption: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'committed', componentId: 'sample-component' } };
void incompleteCommitted;
