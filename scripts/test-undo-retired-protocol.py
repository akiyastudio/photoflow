"""Regression coverage for permanent undo-record retirement."""

import multiprocessing
import json
import hashlib
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

import domain_recovery  # noqa: E402
import operations_db  # noqa: E402
import workspace_db  # noqa: E402


def raw(database, record_id):
    db = sqlite3.connect(database)
    try:
        return db.execute(
            "SELECT id,kind,payload_json,state,created_at,updated_at FROM undo_records WHERE id=?",
            (record_id,),
        ).fetchone()
    finally:
        db.close()


def claim_token(database, record_id):
    row = raw(database, record_id)
    fields = list(row)
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def retire_in_process(database, record_id, completed):
    operations_db.execute(database, "undo_record_retire_claim", {"id": record_id})
    completed.set()


def add_in_process(database, record_id, retired, outcome):
    retired.wait(10)
    try:
        operations_db.execute(database, "undo_record_add", {"id": record_id, "kind": "trash", "payload": {"revived": True}})
        outcome.put("added")
    except Exception as error:  # Cross-process assertion transports the stable code.
        outcome.put(getattr(error, "code", type(error).__name__))


def simultaneous_retire(database, record_id, barrier, outcome):
    barrier.wait(10)
    try:
        result = operations_db.execute(database, "undo_record_retire_claim", {"id": record_id})
        outcome.put(("retire", result["retired"]))
    except Exception as error:
        outcome.put(("retire-error", getattr(error, "code", type(error).__name__)))


def simultaneous_add(database, record_id, barrier, outcome):
    barrier.wait(10)
    try:
        operations_db.execute(database, "undo_record_add", {"id": record_id, "kind": "trash", "payload": {"race": True}})
        outcome.put(("add", True))
    except Exception as error:
        outcome.put(("add", getattr(error, "code", type(error).__name__)))


def replace_record_in_process(database, record_id):
    operations_db.execute(database, "undo_record_add", {"id": record_id, "kind": "trash", "payload": {"version": "new"}})


def claim_old_token_in_process(database, record_id, token, outcome):
    result = operations_db.execute(database, "undo_record_claim_execute", {"id": record_id, "claimToken": token})
    outcome.put(result["claimed"])


def assert_backend_retirement(add, retire, claim_execute, remove, mark, database):
    add("ready", {"large": "x" * 100_000})
    assert retire("ready")["retired"] is False
    assert raw(database, "ready")[3] == "ready"
    mark("ready")
    assert retire("ready")["retired"] is True
    row = raw(database, "ready")
    assert row[1:4] == ("claim-retired", "{}", "retired"), "retirement must compact old payloads"
    mark("ready")
    remove("ready")
    assert raw(database, "ready")[3] == "retired", "mark/remove cannot erase permanent IDs"
    assert retire("absent")["retired"] is True
    try:
        add("absent", {"revived": True})
        raise AssertionError("retired ID was revived")
    except Exception as error:
        assert getattr(error, "code", "") == "UNDO_RECORD_RETIRED"
    add("unknown", {"state": "future"})
    state_db = sqlite3.connect(database)
    try:
        state_db.execute("UPDATE undo_records SET state='future-state' WHERE id='unknown'")
        state_db.commit()
    finally:
        state_db.close()
    assert retire("unknown")["retired"] is False
    assert raw(database, "unknown")[3] == "future-state", "unknown states fail closed without mutation"
    remove("unknown")
    add("execute", {"large": "y" * 100_000})
    execute_token = claim_token(database, "execute")
    assert claim_execute("execute", execute_token)["claimed"] is True
    assert raw(database, "execute")[1:4] == ("claim-retired", "{}", "retired")
    assert claim_execute("execute", execute_token)["claimed"] is False
    assert claim_execute("missing-execute", "0" * 64)["claimed"] is False
    add("wrong-kind", {})
    wrong_kind = sqlite3.connect(database)
    try:
        wrong_kind.execute("UPDATE undo_records SET kind='project-cleanup' WHERE id='wrong-kind'")
        wrong_kind.commit()
    finally:
        wrong_kind.close()
    assert claim_execute("wrong-kind", claim_token(database, "wrong-kind"))["claimed"] is False
    assert raw(database, "wrong-kind")[3] == "ready"
    remove("wrong-kind")
    add("version-race", {"version": "old"})
    old_token = claim_token(database, "version-race")
    add("version-race", {"version": "new"})
    assert claim_execute("version-race", old_token)["claimed"] is False
    assert raw(database, "version-race")[3] == "ready"
    remove("version-race")


def run():
    with tempfile.TemporaryDirectory(prefix="photoflow-retired-", ignore_cleanup_errors=True) as temporary:
        temporary_path = Path(temporary)
        operations = str(temporary_path / "operations.sqlite3")
        operations_db.execute(operations, "init", {})
        assert_backend_retirement(
            lambda record_id, payload: operations_db.execute(operations, "undo_record_add", {"id": record_id, "kind": "trash", "payload": payload}),
            lambda record_id: operations_db.execute(operations, "undo_record_retire_claim", {"id": record_id}),
            lambda record_id, token: operations_db.execute(operations, "undo_record_claim_execute", {"id": record_id, "claimToken": token}),
            lambda record_id: operations_db.execute(operations, "undo_record_remove", {"id": record_id}),
            lambda record_id: operations_db.execute(operations, "undo_record_mark_unavailable", {"id": record_id}),
            operations,
        )
        operations_db.execute(operations, "undo_record_remove_many", {"ids": ["ready", "absent"]})
        assert raw(operations, "ready")[3] == raw(operations, "absent")[3] == "retired"
        assert operations_db.execute(operations, "undo_record_list", {})["records"] == []

        legacy = str(temporary_path / "legacy.sqlite3")
        legacy_db = sqlite3.connect(legacy)
        try:
            legacy_db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            legacy_db.execute("CREATE TABLE undo_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)")
            legacy_db.execute("INSERT INTO undo_records VALUES('ready','trash','{\"legacy\":true}','ready',1,1)")
            legacy_db.execute("INSERT INTO meta VALUES('operations_outbox_v1','{\"removeUndoIds\":[\"ready\",\"absent\"]}')")
            legacy_db.commit()
        finally:
            legacy_db.close()
        operations_db.execute(operations, "init", {"legacyDatabase": legacy})
        assert raw(operations, "ready")[3] == raw(operations, "absent")[3] == "retired", "legacy import/outbox cleanup cannot erase or revive retired IDs"

        # Two OS processes exercise independent SQLite connections at the GC/add boundary.
        completed = multiprocessing.Event()
        outcome = multiprocessing.Queue()
        retired_process = multiprocessing.Process(target=retire_in_process, args=(operations, "process-race", completed))
        add_process = multiprocessing.Process(target=add_in_process, args=(operations, "process-race", completed, outcome))
        retired_process.start(); add_process.start(); retired_process.join(15); add_process.join(15)
        assert retired_process.exitcode == add_process.exitcode == 0
        assert outcome.get(timeout=2) == "UNDO_RECORD_RETIRED"
        assert raw(operations, "process-race")[3] == "retired"

        for index in range(12):
            record_id = f"simultaneous-{index}"
            barrier = multiprocessing.Barrier(2)
            race_outcome = multiprocessing.Queue()
            retire_process = multiprocessing.Process(target=simultaneous_retire, args=(operations, record_id, barrier, race_outcome))
            add_process = multiprocessing.Process(target=simultaneous_add, args=(operations, record_id, barrier, race_outcome))
            retire_process.start(); add_process.start(); retire_process.join(15); add_process.join(15)
            assert retire_process.exitcode == add_process.exitcode == 0
            outcomes = {race_outcome.get(timeout=2), race_outcome.get(timeout=2)}
            state = raw(operations, record_id)[3]
            if state == "ready":
                assert ("add", True) in outcomes and ("retire", False) in outcomes
            else:
                assert state == "retired"
                assert ("retire", True) in outcomes and ("add", "UNDO_RECORD_RETIRED") in outcomes

        operations_db.execute(operations, "undo_record_add", {"id": "process-version-race", "kind": "trash", "payload": {"version": "old"}})
        process_old_token = claim_token(operations, "process-version-race")
        replacement_process = multiprocessing.Process(target=replace_record_in_process, args=(operations, "process-version-race"))
        replacement_process.start(); replacement_process.join(15); assert replacement_process.exitcode == 0
        version_outcome = multiprocessing.Queue()
        claim_process = multiprocessing.Process(target=claim_old_token_in_process, args=(operations, "process-version-race", process_old_token, version_outcome))
        claim_process.start(); claim_process.join(15); assert claim_process.exitcode == 0
        assert version_outcome.get(timeout=2) is False and raw(operations, "process-version-race")[3] == "ready"
        operations_db.execute(operations, "undo_record_remove", {"id": "process-version-race"})

        snapshot = str(temporary_path / "snapshot.sqlite3")
        operations_db.snapshot(operations, snapshot)
        assert raw(snapshot, "process-race")[3] == "retired", "snapshots preserve retired rows"

        # Restoring an older ready row over a live retired row must union the tombstone set.
        old = str(temporary_path / "old.sqlite3")
        old_db = sqlite3.connect(old)
        try:
            old_db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            old_db.execute("CREATE TABLE undo_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)")
            old_db.execute("INSERT INTO meta VALUES('schema_version','1')")
            old_db.execute("INSERT INTO meta VALUES('domain_identity','operations')")
            old_db.execute("INSERT INTO undo_records VALUES('process-race','trash','{\"old\":true}','ready',1,1)")
            old_db.commit()
        finally:
            old_db.close()
        domain_recovery.restore_workspace(old, operations, "operations", [])
        restored = raw(operations, "process-race")
        assert restored[1:4] == ("claim-retired", "{}", "retired")
        schema_probe = sqlite3.connect(operations)
        try:
            assert schema_probe.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "2"
        finally:
            schema_probe.close()
        try:
            operations_db.execute(operations, "undo_record_add", {"id": "process-race", "kind": "trash", "payload": {}})
            raise AssertionError("restore revived a retired ID")
        except Exception as error:
            assert getattr(error, "code", "") == "UNDO_RECORD_RETIRED"
        schema_one_live = str(temporary_path / "schema-one-live.sqlite3")
        schema_one_db = sqlite3.connect(schema_one_live)
        try:
            schema_one_db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            schema_one_db.execute("CREATE TABLE undo_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)")
            schema_one_db.execute("INSERT INTO meta VALUES('schema_version','1')"); schema_one_db.execute("INSERT INTO meta VALUES('domain_identity','operations')")
            schema_one_db.execute("INSERT INTO undo_records VALUES('schema-one-retired','claim-retired','{}','retired',1,1)"); schema_one_db.commit()
        finally:
            schema_one_db.close()
        domain_recovery.reset_store(schema_one_live, "operations")
        assert raw(schema_one_live, "schema-one-retired")[3] == "retired"
        schema_one_probe = sqlite3.connect(schema_one_live)
        try: assert schema_one_probe.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "2"
        finally: schema_one_probe.close()
        domain_recovery.reset_store(operations, "operations")
        assert raw(operations, "process-race")[1:4] == ("claim-retired", "{}", "retired")
        domain_recovery.restore_workspace(old, operations, "operations", [])
        assert raw(operations, "process-race")[3] == "retired", "reset followed by an old ready snapshot cannot revive a retired ID"
        try:
            operations_db.execute(operations, "undo_record_add", {"id": "process-race", "kind": "trash", "payload": {}})
            raise AssertionError("reset lost a retired ID")
        except Exception as error:
            assert getattr(error, "code", "") == "UNDO_RECORD_RETIRED"
        supported_operations_schema = operations_db.SCHEMA_VERSION
        try:
            operations_db.SCHEMA_VERSION = 1
            operations_db._READY_CACHE.clear()
            try:
                operations_db.execute(operations, "init", {})
                raise AssertionError("schema-1 worker accepted semantic schema 2")
            except RuntimeError as error:
                assert "newer than supported" in str(error)
        finally:
            operations_db.SCHEMA_VERSION = supported_operations_schema
            operations_db._READY_CACHE.clear()

        workspace_root = str(temporary_path / "workspace")
        os.makedirs(workspace_root)
        core = str(temporary_path / "workspace.sqlite3")
        workspace_db.load(workspace_root, core)
        supported_core_schema = workspace_db.TARGET_SCHEMA_VERSION
        try:
            workspace_db.TARGET_SCHEMA_VERSION = 33
            try:
                workspace_db.connect(workspace_root, core)
                raise AssertionError("schema-33 core worker accepted semantic schema 34")
            except RuntimeError as error:
                assert "高于当前软件支持" in str(error)
        finally:
            workspace_db.TARGET_SCHEMA_VERSION = supported_core_schema
        assert_backend_retirement(
            lambda record_id, payload: workspace_db.mutate(workspace_root, core, "undo_record_add", {"id": record_id, "kind": "trash", "payload": payload}),
            lambda record_id: workspace_db.mutate(workspace_root, core, "undo_record_retire_claim", {"id": record_id}),
            lambda record_id, token: workspace_db.mutate(workspace_root, core, "undo_record_claim_execute", {"id": record_id, "claimToken": token}),
            lambda record_id: workspace_db.mutate(workspace_root, core, "undo_record_remove", {"id": record_id}),
            lambda record_id: workspace_db.mutate(workspace_root, core, "undo_record_mark_unavailable", {"id": record_id}),
            core,
        )
        workspace_db.mutate(workspace_root, core, "undo_record_add", {"id": "fallback-ready", "kind": "trash", "payload": {"visible": True}})
        workspace_db.mutate(workspace_root, core, "undo_record_add", {"id": "fallback-other", "kind": "future-kind", "payload": {"visible": False}})
        fallback_list = workspace_db.mutate(workspace_root, core, "undo_record_list", {"kinds": ["trash", "project-cleanup"]})["records"]
        assert [record["id"] for record in fallback_list] == ["fallback-ready"]
        all_fallback_records = workspace_db.mutate(workspace_root, core, "undo_record_list", {"kinds": []})["records"]
        assert {record["id"] for record in all_fallback_records} == {"fallback-ready", "fallback-other"}
        workspace_db.mutate(workspace_root, core, "undo_record_remove_many", {"ids": ["fallback-ready", "fallback-other", "ready", "absent", "execute"]})
        assert raw(core, "fallback-ready") is None
        assert raw(core, "ready")[3] == raw(core, "absent")[3] == raw(core, "execute")[3] == "retired"
        workspace_db.mutate(workspace_root, core, "undo_record_shadow_retire", {"id": "shadow-only"})
        assert raw(core, "shadow-only")[1:4] == ("claim-retired", "{}", "retired")
        domain_recovery.sync_retired_shadow(operations, core)
        assert raw(core, "process-race")[3] == "retired", "final operations retired IDs are unioned into core after restore"

        broken_operations = str(temporary_path / "broken-operations.sqlite3")
        broken = sqlite3.connect(broken_operations); broken.execute("CREATE TABLE unrelated(value TEXT)"); broken.execute("INSERT INTO unrelated VALUES('preserve')"); broken.commit(); broken.close()
        domain_recovery.reset_store(broken_operations, "operations", core)
        assert raw(broken_operations, "shadow-only")[3] == "retired"
        try:
            operations_db.execute(broken_operations, "undo_record_add", {"id": "shadow-only", "kind": "trash", "payload": {}})
            raise AssertionError("reset over corrupt operations lost the core shadow")
        except Exception as error:
            assert getattr(error, "code", "") == "UNDO_RECORD_RETIRED"

        os.remove(broken_operations)
        broken = sqlite3.connect(broken_operations); broken.execute("CREATE TABLE unrelated(value TEXT)"); broken.commit(); broken.close()
        domain_recovery.restore_workspace(old, broken_operations, "operations", [], core)
        assert raw(broken_operations, "shadow-only")[3] == "retired"

        doubly_broken = str(temporary_path / "doubly-broken-operations.sqlite3"); broken_core = str(temporary_path / "broken-core.sqlite3")
        for broken_path in (doubly_broken, broken_core):
            broken_db = sqlite3.connect(broken_path)
            try:
                broken_db.execute("CREATE TABLE unrelated(value TEXT)"); broken_db.commit()
            finally:
                broken_db.close()
        before_doubly_broken = Path(doubly_broken).read_bytes()
        try:
            domain_recovery.reset_store(doubly_broken, "operations", broken_core)
            raise AssertionError("reset proceeded without any verifiable retired-ID source")
        except RuntimeError as error:
            assert "cannot verify any retired-ID source" in str(error)
        assert Path(doubly_broken).read_bytes() == before_doubly_broken
        wrong_identity = str(temporary_path / "wrong-identity-operations.sqlite3")
        wrong_db = sqlite3.connect(wrong_identity)
        try:
            wrong_db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)"); wrong_db.execute("INSERT INTO meta VALUES('schema_version','2')"); wrong_db.execute("INSERT INTO meta VALUES('domain_identity','media')")
            wrong_db.execute("CREATE TABLE undo_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"); wrong_db.commit()
        finally: wrong_db.close()
        before_wrong_identity = Path(wrong_identity).read_bytes()
        try:
            domain_recovery.reset_store(wrong_identity, "operations", broken_core)
            raise AssertionError("wrong-domain retired source was trusted")
        except RuntimeError as error:
            assert "cannot verify any retired-ID source" in str(error)
        assert Path(wrong_identity).read_bytes() == before_wrong_identity
        db = sqlite3.connect(core)
        db.row_factory = sqlite3.Row
        try:
            assert workspace_db._operation_undo_records(db) == []
            assert workspace_db._operation_undo_records(db, {"undoRecords": [{"id": "x", "state": "retired", "payload": {"secret": True}}]}) == []
            now = 1_700_000_000_000
            db.execute("INSERT INTO projects(id,name,status,relative_path,is_deleted,availability,created_at,updated_at) VALUES('purge-project','Purge Project','策划中','Purge Project',1,'available',?,?)", (now, now))
            db.execute("INSERT INTO undo_records(id,kind,payload_json,state,created_at,updated_at) VALUES('purge-retired','trash',?,'unavailable',?,?)", (json.dumps({"projectCatalog": {"name": "Purge Project"}}), now, now))
            journal = {"version": 1, "projectId": "purge-project", "projectName": "Purge Project", "deleted": True, "stage": "compatibility", "photoIds": [], "versionIds": [], "batchIds": [], "sessionIds": [], "snapshotIds": [], "removedUndoIds": ["purge-retired"], "externalUndo": False, "result": {"success": True, "removedUndoIds": ["purge-retired"]}, "createdAt": now, "updatedAt": now}
            db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('purge_journal_v1',?)", (json.dumps(journal),))
            # Simulate the GC CAS after the purge journal captured this ID but before finalization.
            db.execute("UPDATE undo_records SET kind='claim-retired',payload_json='{}',state='retired' WHERE id='purge-retired' AND state='unavailable'")
            db.commit()
        finally:
            db.close()
        replay = workspace_db.connect(workspace_root, core)
        replay.close()
        assert raw(core, "purge-retired")[1:4] == ("claim-retired", "{}", "retired"), "purge replay cannot delete a concurrently retired ID"

    print("Undo retired-ID protocol tests passed.")


if __name__ == "__main__":
    multiprocessing.freeze_support()
    run()
