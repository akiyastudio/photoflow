# PhotoFlow architecture

PhotoFlow is a modular desktop monolith. Features remain in one Electron
application, but code must cross feature boundaries through explicit service or
IPC contracts. Network microservices are intentionally not required for local
file workflows.

## Dependency direction

1. React features call only APIs exposed by `electron/preload.cjs`.
2. IPC modules validate requests and delegate work to application services.
3. Services own workflows and may call repositories, workers, or operating
   system adapters.
4. Repositories are the only code allowed to know SQLite table structure.
5. Python and packaged component processes are workers, not sources of UI state.

## Current module boundaries

- `electron/main.cjs`: application composition root only. It creates services,
  workers and windows, registers feature modules, and owns lifecycle cleanup.
  A regression test prevents IPC handlers from moving back into this file.
- `electron/modules`: IPC-facing adapters grouped into system, workspace,
  file-operation, media, version, B-roll, and background-task domains. Public
  channel names are unchanged.
- `electron/services`: application workflows and reusable infrastructure.
  `WorkspaceService`, `FileSystemService`, `ThumbnailService`, `MediaService`,
  and `VersionService` form the core domain boundary. The event bus and
  background task service provide task IDs, progress, cancellation and retry.
  File-transfer planning and the bounded small/large copy scheduler live in the
  filesystem service rather than the Electron composition root.
- `electron/repositories`: the only JavaScript modules that know Python
  database action names. IPC and services call domain methods instead.
- `electron/plugins`: the optional-plugin catalog and capability mapping.
  Team retouch and research tools are resolved through `PluginService`, not
  through hard-coded executable paths in IPC handlers.
- `electron/native/RecycleBinService.cs`: Windows-only operating-system adapter
  for verified recycle, exact-item restore, and recycle capability probing.
- `electron/thumbnail-pipeline.cjs`: thumbnail scheduling and cache domain.
- `electron/component-registry.cjs`: optional packaged component discovery.
- `python/workspace_db.py`: workspace database worker. New SQL should move
  behind domain-specific repository functions rather than IPC handlers.
  It also owns the lightweight persistent undo journal; no deleted media bytes
  are stored in SQLite.
- `src/features/workspace`: the project browser, preview, metadata, version and
  team-retouch workspace UI.
- `src/features/tools`: import, birthday, conversion, research, matching and
  video-splitting tools.
- `src/features/settings`, `src/features/plugins`, and
  `src/features/background-tasks`: settings, plugin availability and observable
  background-task UI. `src/App.tsx` is now the 684-line application shell
  rather than the previous 4,000-line feature container.

## Stable contracts

Existing preload and IPC method names are compatibility contracts. Internal
modules may be replaced without changing renderer behaviour. Long-running file
operations report progress through `workspace-file-operation-progress` and use
the shared `ProjectFileOperationProgress` type.

## Completed migration stages

1. Safety tests cover thumbnails, atomic transfer, file identity, path grants,
   persistent undo, component probing, and IPC/preload contract registration.
2. IPC handlers, database repositories, and React feature blocks were moved out
   of the two application entry files without changing public API names.
3. Core workflows now cross explicit workspace, filesystem, thumbnail, media,
   version, repository and plugin service boundaries.
4. Workspace reconciliation, thumbnail generation and cache cleanup publish
   observable task state through an in-process event bus. The renderer can list,
   cancel and retry supported tasks.
5. Team retouch and research tools are optional capability-based plugins. Core
   workspace, filesystem, media, thumbnail and version features remain bundled.

`npm run test:architecture` enforces the important entry-file size, IPC
registration, repository and plugin capability contracts.
