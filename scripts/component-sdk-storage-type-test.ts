import type { ComponentStorageResponse } from '../component-sdk/index.js';

const pending: ComponentStorageResponse = {
  apiVersion: 2, projectId: 'project', ownership: 'component-private',
  adoption: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'pending', componentId: 'sample-component', fromHostApiVersion: 1, toHostApiVersion: 2, startedAt: 1 },
};
if (pending.adoption?.state === 'pending') {
  // @ts-expect-error Pending adoption intentionally grants no readable or writable path.
  void pending.dataPath;
}

const committed: ComponentStorageResponse = {
  apiVersion: 2, dataPath: 'private', databasePath: 'private/storage.sqlite3', projectId: 'project', ownership: 'component-private',
  adoption: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'committed', componentId: 'sample-component', fromHostApiVersion: 1, toHostApiVersion: 2, adoptedDataRoot: true, adoptedDatabase: true, legacyDataRoot: 'legacy', legacyDatabasePath: 'legacy.sqlite3', databaseSha256: 'digest', copiedFileCount: 2, copiedByteCount: 3 },
};
void committed.dataPath;

// @ts-expect-error A committed receipt must include verification counts, flags, digest, and legacy references.
const incompleteCommitted: ComponentStorageResponse = { apiVersion: 2, dataPath: 'private', databasePath: 'db', projectId: 'project', ownership: 'component-private', adoption: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'committed', componentId: 'sample-component', fromHostApiVersion: 1, toHostApiVersion: 2 } };
void incompleteCommitted;
