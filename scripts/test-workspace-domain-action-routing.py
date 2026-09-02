from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db  # noqa: E402
import workspace_media_actions  # noqa: E402
from workspace_storage_ownership import ACTION_IMPLEMENTATION_OWNERS  # noqa: E402


def main() -> None:
    declared = set(ACTION_IMPLEMENTATION_OWNERS["workspace_media_actions"])
    assert declared == set(workspace_media_actions.ACTION_NAMES)
    assert declared == set(workspace_media_actions.ACTION_HANDLERS)
    assert declared < set(workspace_db.MEDIA_ACTIONS)
    assert set(workspace_db.MEDIA_ACTIONS) - declared == {"media_workflow_import_commit"}

    core_tree = ast.parse((ROOT / "python" / "workspace_db.py").read_text(encoding="utf-8"))
    core_definitions = {
        node.name for node in core_tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
    }
    assert not declared & core_definitions, "domain actions must not retain duplicate core implementations"

    media_source = (ROOT / "python" / "workspace_media_actions.py").read_text(encoding="utf-8")
    assert "\ufffd" not in media_source, "domain extraction must preserve UTF-8 error contracts"
    media_tree = ast.parse(media_source)
    imports = {
        alias.name.split(".", 1)[0]
        for node in media_tree.body if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        str(node.module or "").split(".", 1)[0]
        for node in media_tree.body if isinstance(node, ast.ImportFrom)
    }
    assert imports <= {
        "__future__", "hashlib", "json", "math", "os", "re", "sqlite3", "time", "uuid",
        "compatibility", "workspace_db_support",
    }
    assert "workspace_db" not in imports, "media domain must not depend on the composition root"

    for action, handler in workspace_media_actions.ACTION_HANDLERS.items():
        assert callable(handler), action
        assert handler.__module__ == "workspace_media_actions", action

    calls = []

    def root_handler(root, db, payload):
        calls.append((root, db, payload))
        return {"route": "root"}

    def database_handler(db, payload):
        calls.append((db, payload))
        return {"route": "database"}

    original_root = workspace_media_actions.ACTION_HANDLERS["media_get"]
    original_database = workspace_media_actions.ACTION_HANDLERS["media_get_photo"]
    try:
        workspace_media_actions.ACTION_HANDLERS["media_get"] = root_handler
        workspace_media_actions.ACTION_HANDLERS["media_get_photo"] = database_handler
        assert workspace_media_actions.dispatch_action("media_get", "root", "db", {"id": 1}) == {"route": "root"}
        assert workspace_media_actions.dispatch_action("media_get_photo", "root", "db", {"id": 2}) == {"route": "database"}
        assert calls == [("root", "db", {"id": 1}), ("db", {"id": 2})]
    finally:
        workspace_media_actions.ACTION_HANDLERS["media_get"] = original_root
        workspace_media_actions.ACTION_HANDLERS["media_get_photo"] = original_database

    try:
        workspace_media_actions.dispatch_action("not-a-media-action", "root", "db", {})
    except ValueError as error:
        assert str(error) == "unknown media domain action: not-a-media-action"
    else:
        raise AssertionError("unknown actions must be rejected by the domain router")

    print("Workspace media domain action routing tests passed.")


if __name__ == "__main__":
    main()
