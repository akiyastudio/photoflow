# Workspace storage isolation

Workspace state is split by owning domain under the stable workspace ID. The
current physical layout is:

| Owner | Store | Status |
| --- | --- | --- |
| workspace/media/versioning | `workspace-data/<workspace-id>.sqlite3` | legacy shared core store |
| file-operations | `workspace-data/<workspace-id>/databases/operations.sqlite3` | isolated |
| team-retouch | `workspace-data/<workspace-id>/databases/team-retouch.sqlite3` | isolated |

The next extraction order is media, versioning, and finally the workspace
catalog. New domain-owned tables must not be added to the shared core store.

## Migration and rollback

- `operations_db.py` imports legacy `undo_records` with `INSERT OR IGNORE` and
  writes a completion marker in the target database. The source table is left
  untouched as a rollback copy, but runtime reads and writes use only the owned
  store after migration.
- `python/compatibility/team_retouch_v1/storage.py` creates the owned schema, copies all five legacy
  team tables, and drops those tables from the core database in one attached
  SQLite transaction. A pre-schema-migration backup still contains the legacy
  layout if an older application must be restored.
- Cross-store references use stable project, photo, and version IDs. SQLite
  cannot enforce foreign keys across files, so deletion paths explicitly clean
  team rows and integrity maintenance validates the references.

## Backup and recovery

Active SQLite files are never copied directly. Backup creates online snapshots
for the core, operations, and team-retouch databases and stores the two domain
databases as `domain-database` manifest entries. Full-workspace restore restores
all three stores and rebases owned paths. Project restore imports only the
selected project's team rows; operations history remains workspace-scoped.

Each owned database has an independent WAL and schema version. A corrupt or
missing operations store affects undo history, while a corrupt or missing
team-retouch store affects team workflow state; neither prevents the project
catalog database from opening. Automated tests cover legacy import, physical
table separation, deletion cleanup, online snapshot, workspace restore, and
project-scoped team restore.
