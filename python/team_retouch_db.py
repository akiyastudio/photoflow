"""Backup and restore utility for the isolated team-retouch store."""

import argparse
import json
import sys

from team_retouch_storage import rebase_workspace, restore_project, snapshot


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
        result = rebase_workspace(args.destination, _replacements(args))
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
