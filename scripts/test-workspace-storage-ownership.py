from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import domain_recovery  # noqa: E402
import operations_db  # noqa: E402
import workspace_db  # noqa: E402
from workspace_db_migrations import CANONICAL_STORAGE_DOMAINS, MIGRATION_METADATA, MIGRATION_OWNERS  # noqa: E402
from workspace_storage_ownership import DOMAIN_TABLES, STORAGE_OWNERSHIP  # noqa: E402


def tables(db: sqlite3.Connection, schema: str = "main") -> set[str]:
    return {
        row[0] for row in db.execute(
            f"SELECT name FROM {schema}.sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }


def main() -> None:
    assert tuple(workspace_db.MIGRATIONS) == tuple(MIGRATION_OWNERS), "every ordered workspace migration needs an owner"
    assert tuple(MIGRATION_OWNERS) == tuple(range(min(MIGRATION_OWNERS), max(MIGRATION_OWNERS) + 1))
    assert workspace_db.TARGET_SCHEMA_VERSION == STORAGE_OWNERSHIP["workspace"]["schemaVersion"]
    assert all(owners for owners in MIGRATION_OWNERS.values())
    assert all(
        set(owners) <= CANONICAL_STORAGE_DOMAINS for owners in MIGRATION_OWNERS.values()
    ), "migration owners must be canonical workspace/media/versioning/operations domains"
    assert MIGRATION_METADATA[34]["retainedRollbackShadow"] == "workspace.undo_records"
    assert MIGRATION_METADATA[34]["runtimeOwner"] == "operations"
    assert {version for version, metadata in MIGRATION_METADATA.items() if metadata.get("compatibilityHook")} == {11, 15, 17, 32}
    for domain in CANONICAL_STORAGE_DOMAINS:
        expected_versions = tuple(
            version for version, owners in MIGRATION_OWNERS.items() if domain in owners
        )
        assert STORAGE_OWNERSHIP[domain]["workspaceMigrationVersions"] == expected_versions
    assert tuple(operations_db.MIGRATIONS) == STORAGE_OWNERSHIP["operations"]["migrationVersions"]
    assert operations_db.SCHEMA_VERSION == STORAGE_OWNERSHIP["operations"]["schemaVersion"]
    function_names = {
        "verify": "verify", "snapshot": "snapshot", "restore-workspace": "restore_workspace",
        "restore-project": "restore_project", "reset": "reset_store",
        "sync-retired-shadow": "sync_retired_shadow",
    }
    for domain in ("media", "versioning", "operations"):
        declared = STORAGE_OWNERSHIP[domain]
        assert domain_recovery.SUPPORTED_SCHEMA_VERSIONS[domain] == declared["schemaVersion"]
        assert set(domain_recovery.REQUIRED_COLUMNS[domain]) == set(declared["tables"])
        for action in declared["recoveryActions"]:
            assert callable(getattr(domain_recovery, function_names[action]))
    for domain in DOMAIN_TABLES:
        declared = STORAGE_OWNERSHIP[domain]
        assert set(declared["tables"]) == {"meta", *DOMAIN_TABLES[domain]}

    with tempfile.TemporaryDirectory(prefix="photoflow-storage-ownership-") as temporary:
        base = Path(temporary)
        root = base / "workspace"
        root.mkdir()
        database = base / "workspace-data" / "workspace-id.sqlite3"
        db = workspace_db.connect(str(root), str(database), include_domains=True)
        try:
            assert tables(db) == set(STORAGE_OWNERSHIP["workspace"]["tables"])
            assert tables(db, "media") == set(STORAGE_OWNERSHIP["media"]["tables"])
            assert tables(db, "versioning") == set(STORAGE_OWNERSHIP["versioning"]["tables"])
        finally:
            db.close()

        operations_path = base / "workspace-data" / "workspace-id" / "databases" / "operations.sqlite3"
        operations = operations_db._connect(str(operations_path))
        try:
            assert tables(operations) == set(STORAGE_OWNERSHIP["operations"]["tables"])
        finally:
            operations.close()

    print("Workspace storage ownership contract tests passed.")


if __name__ == "__main__":
    main()
