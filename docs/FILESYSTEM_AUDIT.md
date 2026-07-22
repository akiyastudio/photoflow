# Filesystem audit

## Fixed in this change

- Large B-roll files no longer use synchronous `copyFileSync` on Electron's
  main thread.
- File copies are streamed to a unique temporary file and atomically renamed,
  so a crash does not leave a valid-looking partial destination.
- Cross-volume moves copy atomically and remove the source only after verifying
  the complete destination size.
- B-roll import reports byte progress, supports cancellation, checks available
  destination space, and cleans partial copies/segments on failure.
- Large split videos are segmented directly from the source into the project;
  they are not first duplicated into the project and duplicated again into an
  application undo backup.
- Batch file/progress imports now share the same transfer service and roll back
  already completed entries when a later entry fails.
- Project path checks reject lexical traversal and existing symlink/junction
  escapes. Project browsing does not expose symbolic-link entries.
- Media IPC requests are limited to active workspace/cache roots or a
  short-lived grant issued by a native file dialog. Custom media URLs now carry
  random in-memory tokens rather than encoded absolute filesystem paths.
- Undo entries capture filesystem identity and refuse to remove or rename a
  same-path replacement.
- Windows deletion no longer creates a full AppData backup. A native Shell
  helper captures the Recycle Bin item identity and SQLite stores only the
  recovery journal. The helper probes each volume first and refuses deletion
  if recoverability cannot be verified.
- Delete recovery survives application restarts, detects manual restore and
  emptied-bin states, preserves records while removable volumes are offline,
  and offers rename/replace/cancel when the original location is occupied.
- Recursive undo cleanup, component-size enumeration, PNG signature scans,
  project-folder listing, B-roll output scans, and thumbnail result inspection
  no longer use synchronous main-process filesystem APIs.
- `fs.watch` is backed by a five-minute full catalog, media-version, and
  thumbnail-index reconciliation pass.
- Main-process IPC is separated by domain and database action strings are
  isolated in repositories, reducing the chance that a UI handler bypasses
  filesystem or database safety rules.
- Workspace reconciliation, thumbnail generation, and cache cleanup are
  observable background tasks with IDs and progress. Supported tasks can be
  cancelled and retried from the title bar.

## Remaining risks and recommended follow-up

### Medium: remaining synchronous filesystem work

Startup configuration/log maintenance and bounded existence/stat probes still
use synchronous filesystem APIs. File-operation planning is limited to 500
selected paths and does not recursively scan with synchronous APIs, but a slow
network share can still cause a short main-process pause while those probes are
evaluated. Actual copying, moving, directory enumeration, hashing and recursive
size calculation are asynchronous. Convert the remaining probes when the file
operation module is split into smaller commands.

### Medium: network/removable-drive interruption

Atomic destination publishing prevents corrupt final files, but removable and
network volumes can disappear between validation and transfer. Errors are
rolled back best-effort; failed rollback needs a persistent recovery journal so
the next launch can finish cleanup.

### Medium: watcher overflow and external races

`fs.watch` is advisory and may coalesce or drop events. Periodic reconciliation
now provides eventual consistency; a future diagnostics screen should expose
its last-success timestamp and backlog.

### Medium: platform-specific recycle recovery

Precise in-app restore currently requires the bundled Windows Shell helper.
Other platforms fall back to their system trash and require manual recovery.
Windows volumes whose recycle behavior cannot be verified are deliberately
blocked rather than risking an unexpected permanent delete.

### Medium: background task persistence

Task progress and retry closures are process-local. SQLite/file operations keep
their own durable recovery records, but a thumbnail or cache-cleanup task is not
automatically resumed after an application restart. A future durable scheduler
should persist resumable task definitions rather than JavaScript closures.

### Low: large feature internals

The application entry files are now bounded, but the workspace and tools
features are intentionally coarse first-stage modules. Their internal panels can
be split further without changing IPC or service contracts. Architecture tests
prevent the entry files from growing back while this incremental split continues.

### Medium: disk-space checks are advisory

`statfs` is unavailable on some network providers and available capacity can
change during a transfer. Keep atomic temporary files and surface `ENOSPC` with
the destination and partial-cleanup result.
