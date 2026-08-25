"""Backup and restore utility for the plugin's isolated legacy store."""

import argparse
import json
import sys
from pathlib import Path

if __package__:
    from .storage import restore_project, snapshot
else:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from compatibility.team_retouch_v1.storage import restore_project, snapshot

from domain_recovery import restore_workspace as restore_domain_workspace


def _replacements(args):
    return [
        (args.old_root, args.new_root),
        (args.old_data_root, args.new_data_root),
    ]


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("snapshot", "restore-workspace", "restore-project"))
    parser.add_argument("--source")
    parser.add_argument("--destination", required=True)
    parser.add_argument("--project-id")
    parser.add_argument("--old-root", default="")
    parser.add_argument("--new-root", default="")
    parser.add_argument("--old-data-root", default="")
    parser.add_argument("--new-data-root", default="")
    args = parser.parse_args(args_list)
    if args.action == "snapshot":
        if not args.source:
            parser.error("--source is required")
        result = snapshot(args.source, args.destination)
    elif args.action == "restore-workspace":
        if not args.source:
            parser.error("--source is required")
        result = restore_domain_workspace(args.source, args.destination, "team-retouch", _replacements(args))
    else:
        if not args.source or not args.project_id:
            parser.error("--source and --project-id are required")
        result = restore_project(args.source, args.destination, args.project_id, _replacements(args))
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    run()
