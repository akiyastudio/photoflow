"""Plugin-owned legacy data compatibility helpers."""

from compatibility.registry import LegacyDomain, register_domain, register_exports, register_tool


DOMAIN = LegacyDomain()
register_domain(DOMAIN)
register_tool("team_retouch_db", "compatibility.team_retouch_v1.database_tool")

from . import workspace as _workspace  # noqa: E402,F401
from . import backup as _backup  # noqa: E402,F401
from . import recovery as _recovery  # noqa: E402,F401
from . import storage as _storage  # noqa: E402

register_exports("domain-storage", {
    name: getattr(_storage, name) for name in (
        "attach_and_migrate", "cleanup_empty_recreated_legacy_tables",
        "database_path_for_workspace_database", "ensure_schema", "restore_project", "snapshot",
    )
})
