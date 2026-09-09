# Folder rename timing

Run `npm run build`, then `node scripts/benchmark-folder-rename.cjs` from the repository root. The benchmark requires the development Python environment, Electron dependencies, and the native file publication service used by the application.

The runner resolves the private root with `scripts/project-output-paths.cjs`. Every run creates a new `diagnostics/folder-rename/run-*` directory there, including synthetic workspace folders, an isolated Electron profile, database, stdout/stderr, and `user-data/rename-performance.json`. Failed runs retain their evidence. No existing project, user profile, consent preference, or working directory is renamed. The synthetic profile has telemetry disabled.

The real application and preload APIs are used. Two synthetic projects contain 20 and 1,000 sibling fixture directories. An ordinary directory and a registered progress directory are renamed five times each. A valid original-material parent is registered before creating the progress directory. The probe then uses the actual React selection control, F2 editor, and Enter submission to rename each kind once in list view.

## Measurements

- `ipcMs`: renderer request through backend completion and response delivery.
- `directoryRefreshMs`: a subsequent real directory listing, measured separately from rename completion.
- `projectContentsMs`: a subsequent project contents request.
- `uiActionableMs`: Enter submission until the new-path row exists, its selection control is enabled, and the rename editor is closed. Polling resolution is approximately 10 ms; this includes renderer scheduling and is not a kernel operation measurement. The smoke renderer uses Electron's existing offscreen/software-rendering configuration.
- `followUpRenameReadyMs`: immediately after the row becomes actionable, press F2 again and verify that the editor contains the new name. Escape cancels this follow-up without another filesystem mutation.
- Backend records measure registered-progress queries, external-link discovery, plugin folder-policy discovery, native publication, undo identity capture, progress mutation leases, progress commit, and catalog refresh. Each stage includes its offset and duration. Repeated stages must be summed per operation before aggregating. Do not sum stage medians to reconstruct the median total.
- `nativeRenameIncludingProcessStartup` includes native helper launch/protocol overhead. `progressDatabaseAndFilesystemCommit` includes the database worker round trip, validation, filesystem relocation and database updates; these internal components are not individually isolated by this probe.

Compare the first API sample with later samples rather than assuming the whole process is cold. Database initialization and fixture registration precede measurement, and normal application watchers/background work remain enabled. The UI samples are single observations per scenario, not percentile estimates. Empty synthetic directories do not model network storage, media-heavy directories, antivirus variability, or all production workloads.

Instrumentation is enabled only when both `PHOTOFLOW_SMOKE_TEST=1` and `PHOTOFLOW_RENAME_BENCHMARK=1`. Ordinary application runs retain their original context objects and do not collect timing records. Traces contain stage names, numeric timings and outcomes, never request paths or payloads. The private report can additionally contain the synthetic renderer text if a UI probe fails.

Run `node scripts/test-rename-performance-diagnostics.cjs` to check opt-in isolation, synchronous/async return preservation, errors and trace redaction.

The optimized application scopes external-link discovery to rename sources, caches folder protection rules against component metadata revisions, and uses a supervised persistent Windows move helper. Local progress renames prefer a persisted snapshot (with recovery fallback for missing/external entries), let indexing yield, and return before catalog refresh completes. `node scripts/test-rename-fast-paths.cjs` covers policy invalidation, native no-clobber moves, process reuse, timeout/disconnection handling and no automatic replay of ambiguous mutations.
