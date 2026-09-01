# Workspace storage isolation

Workspace state is physically split by owner under a stable workspace storage
key. The current layout is:

| Owner | Store | Owned state |
| --- | --- | --- |
| workspace catalog | `workspace-data/<workspace-id>.sqlite3` | projects, properties and tags; legacy rollback shadows remain but are not runtime owners |
| media | `workspace-data/<workspace-id>/databases/media.sqlite3` | photos, file records and incremental scan manifests |
| versioning | `workspace-data/<workspace-id>/databases/versioning.sqlite3` | versions, progress graph/layout, batches, tracking and relocation journals |
| file-operations | `workspace-data/<workspace-id>/databases/operations.sqlite3` | active undo records and retired-ID fencing |
| installed components | `workspace-data/<workspace-id>/components/<component-id>/...` | component-declared private storage |

`team-retouch/storage.sqlite3` is the current component-owned team-retouch
store. `databases/team-retouch.sqlite3` is accepted only as a legacy adoption
source. It is not a core workspace database.

The Python ownership contract is machine-readable in
`python/workspace_storage_ownership.py`. It declares the exact core tables,
ordered migration ownership, schema versions and supported recovery actions.
`scripts/test-workspace-storage-ownership.py` creates every active store and
compares its physical tables to that declaration.

## Migration and rollback

- Media and versioning extraction first creates a durable online backup of the
  legacy workspace database, copies and validates the complete owned table
  graph in one attached transaction, then removes the migrated tables from the
  live catalog. The backup path is recorded in catalog metadata.
- The legacy source database and pre-extraction backup are never rewritten as
  part of domain recovery. No migration in this split is irreversible.
- `operations_db.py` imports legacy `undo_records` with `INSERT OR IGNORE` and
  records completion in the operations store. Catalog `undo_records` remains a
  rollback/retired-ID shadow; runtime undo reads and writes use only
  `operations.sqlite3`.
- Component adoption is component-declared. Current component storage is not
  attached to the workspace worker, and legacy domain files remain available
  for rollback until the component's own policy removes them.
- Cross-store references use stable project, photo and version IDs. SQLite
  cannot enforce foreign keys across files, so purge/reconcile paths perform
  explicit cleanup and integrity checks.

The catalog migration driver retains versions 11 through 34 in the same order.
Ownership-scoped implementations for migrations 26 through 34 live in
`workspace_db_migrations.py`; the catalog worker keeps compatibility wrappers so
existing imports, errors and migration sequencing do not change.

## Backup and recovery

Active SQLite files are never copied directly. Backup uses SQLite online
snapshots for the catalog, media, versioning and operations stores. Media,
versioning and operations are recorded as `domain-database` manifest entries;
installed components contribute their own declared backup sources.

Full-workspace restore stages and verifies each store before durable
publication, preserves a pre-restore backup, and rebases owned paths. Project
restore imports only project-owned media/versioning rows and component rows
declared by installed components. Operations history remains workspace-scoped.

Each database has an independent WAL and schema version. A missing or corrupt
media store does not block catalog access and may be reset for reindexing. A
versioning failure does not block catalog or media-only access, but versioning
is not treated as rebuildable. An operations failure affects undo history only;
retired IDs are merged from the retained catalog shadow during reset/restore.

Recovery never deletes old rollback data. Replacement uses a staged database,
integrity and ownership verification, fsync, durable publication, and a
quarantine or pre-restore backup of the previous destination.
