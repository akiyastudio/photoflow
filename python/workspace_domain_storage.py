"""Physical storage extraction for media and versioning bounded contexts.

Catalog-only connections never open these files, so a corrupt or locked media
or versioning store cannot prevent the workspace catalog from opening.
"""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
import time


SCHEMA_VERSION = 1
DOMAIN_TABLES = {
    "media": ("photos", "file_records"),
    "versioning": (
        "versions", "version_batches", "progress_folders", "batch_file_operations",
        "batch_items", "version_compare_history", "tracking_sessions",
        "tracking_session_items", "legacy_selection_relation_repairs",
        "version_tree_layouts", "version_tree_node_positions", "version_graph_edges",
        "media_import_graph_sessions", "media_import_artifact_slots",
    ),
}


def database_path_for_workspace_database(workspace_database: str, domain: str) -> str:
    if domain not in DOMAIN_TABLES:
        raise ValueError(f"unknown workspace storage domain: {domain}")
    absolute = os.path.abspath(workspace_database)
    workspace_key = os.path.splitext(os.path.basename(absolute))[0]
    return os.path.join(os.path.dirname(absolute), workspace_key, "databases", f"{domain}.sqlite3")


def _connect_domain(path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute("PRAGMA busy_timeout=30000")
    if str(db.execute("PRAGMA journal_mode").fetchone()[0]).casefold() != "wal":
        db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
    db.execute(
        "INSERT INTO meta(key,value) VALUES('schema_version',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(SCHEMA_VERSION),),
    )
    db.commit()
    return db


def _strip_cross_store_references(sql: str) -> str:
    sql = re.sub(
        r",?\s*FOREIGN\s+KEY\s*\([^)]*\)\s+REFERENCES\s+(?:[`\"\[]?[A-Za-z_][A-Za-z0-9_]*[`\"\]]?)\s*\([^)]*\)"
        r"(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*",
        "",
        sql,
        flags=re.IGNORECASE,
    )
    return re.sub(
        r"\s+REFERENCES\s+(?:[`\"\[]?[A-Za-z_][A-Za-z0-9_]*[`\"\]]?)\s*\([^)]*\)"
        r"(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*",
        "",
        sql,
        flags=re.IGNORECASE,
    )


def _domain_create_table_sql(sql: str, alias: str, table: str) -> str:
    rewritten = re.sub(
        r"^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:[`\"\[]?[A-Za-z_][A-Za-z0-9_]*[`\"\]]?)",
        f'CREATE TABLE IF NOT EXISTS {alias}."{table}"',
        _strip_cross_store_references(sql),
        count=1,
        flags=re.IGNORECASE,
    )
    if rewritten == sql:
        raise RuntimeError(f"unable to rewrite schema for {table}")
    return rewritten


def _domain_create_index_sql(sql: str, alias: str) -> str:
    return re.sub(
        r"^\s*CREATE\s+(UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:[`\"\[]?([A-Za-z_][A-Za-z0-9_]*)[`\"\]]?)",
        lambda match: f'CREATE {match.group(1) or ""}INDEX IF NOT EXISTS {alias}."{match.group(2)}"',
        sql,
        count=1,
        flags=re.IGNORECASE,
    )


def _copy_legacy_table(workspace_db: sqlite3.Connection, alias: str, table: str) -> None:
    schema = workspace_db.execute(
        "SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if schema is None or not schema[0]:
        return
    create_sql = _domain_create_table_sql(schema[0], alias, table)
    try:
        workspace_db.execute(create_sql)
    except sqlite3.Error as error:
        raise RuntimeError(f"unable to create {alias}.{table}: {error}; sql={create_sql}") from error
    source_columns = [row[1] for row in workspace_db.execute(f'PRAGMA main.table_info("{table}")').fetchall()]
    target_columns = [row[1] for row in workspace_db.execute(f'PRAGMA {alias}.table_info("{table}")').fetchall()]
    columns = [column for column in source_columns if column in target_columns]
    if columns:
        projection = ",".join(f'"{column}"' for column in columns)
        workspace_db.execute(
            f'INSERT OR IGNORE INTO {alias}."{table}"({projection}) SELECT {projection} FROM main."{table}"'
        )
        source_count = workspace_db.execute(f'SELECT COUNT(*) FROM main."{table}"').fetchone()[0]
        target_count = workspace_db.execute(f'SELECT COUNT(*) FROM {alias}."{table}"').fetchone()[0]
        if target_count < source_count:
            raise RuntimeError(f"{alias}.{table} extraction lost rows: {source_count}->{target_count}")
    indexes = workspace_db.execute(
        "SELECT sql FROM main.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", (table,)
    ).fetchall()
    for index in indexes:
        workspace_db.execute(_domain_create_index_sql(index[0], alias))


def _backup_before_extraction(workspace_database: str) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    destination = f"{workspace_database}.before-domain-extraction.{stamp}.bak"
    if not os.path.exists(destination):
        shutil.copy2(workspace_database, destination)
    return destination


def attach_and_migrate(workspace_db: sqlite3.Connection, workspace_database: str) -> dict[str, str]:
    paths = {domain: database_path_for_workspace_database(workspace_database, domain) for domain in DOMAIN_TABLES}
    for domain_path in paths.values():
        probe = _connect_domain(domain_path)
        try:
            check = probe.execute("PRAGMA quick_check").fetchone()[0]
            if check != "ok":
                raise RuntimeError(f"domain database integrity check failed: {check}")
        finally:
            probe.close()
    attached = {row[1] for row in workspace_db.execute("PRAGMA database_list").fetchall()}
    for domain, domain_path in paths.items():
        if domain not in attached:
            workspace_db.execute(f"ATTACH DATABASE ? AS {domain}", (domain_path,))
            workspace_db.execute(f"PRAGMA {domain}.busy_timeout=30000")

    legacy_tables = {
        row[0] for row in workspace_db.execute(
            "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    owned_legacy = [
        (domain, table) for domain, tables in DOMAIN_TABLES.items()
        for table in tables if table in legacy_tables
    ]
    if owned_legacy:
        with workspace_db:
            for domain, table in owned_legacy:
                _copy_legacy_table(workspace_db, domain, table)
        backup_path = _backup_before_extraction(os.path.abspath(workspace_database))
        workspace_db.execute("PRAGMA foreign_keys=OFF")
        with workspace_db:
            for _domain, table in reversed(owned_legacy):
                workspace_db.execute(f'DROP TABLE IF EXISTS main."{table}"')
            workspace_db.execute(
                "INSERT OR REPLACE INTO main.meta(key,value) VALUES('domain_storage_revision',?)",
                (str(SCHEMA_VERSION),),
            )
            workspace_db.execute(
                "INSERT OR REPLACE INTO main.meta(key,value) VALUES('domain_storage_backup',?)",
                (backup_path,),
            )
        workspace_db.execute("PRAGMA foreign_keys=ON")
    return paths


def verify_database(path: str) -> dict:
    absolute = os.path.abspath(path)
    if not os.path.isfile(absolute):
        return {"success": False, "state": "missing", "path": absolute}
    try:
        db = sqlite3.connect(f"file:{absolute}?mode=ro", uri=True, timeout=10)
        try:
            result = [row[0] for row in db.execute("PRAGMA quick_check").fetchall()]
            schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            return {
                "success": result == ["ok"], "state": "healthy" if result == ["ok"] else "corrupt",
                "path": absolute, "schemaVersion": int(schema[0]) if schema else 0,
                "quickCheck": result[:10],
            }
        finally:
            db.close()
    except sqlite3.Error as error:
        return {"success": False, "state": "unavailable", "path": absolute, "error": str(error)}
