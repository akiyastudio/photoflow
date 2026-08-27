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

Optional UI components follow the versioned [Component Host API](./PLUGIN_HOST_API.md): the application owns the project-toolbar button and tab chrome, while an isolated, host-preloaded `WebContentsView` owns the component page. No component UI is injected into the main React DOM.

## Current module boundaries

- `electron/main.cjs`: application composition root only. It creates services,
  workers and windows, registers feature modules, and owns lifecycle cleanup.
  A regression test prevents IPC handlers from moving back into this file.
- `electron/modules`: IPC-facing adapters grouped into system, workspace,
  file-operation, media, version, B-roll, and background-task domains. Public
  channel names are unchanged. Media rating and version tracking have dedicated
  registrars so their validation/serialization boundary is independent from
  the broader version module.
- `electron/services`: application workflows and reusable infrastructure.
  `WorkspaceService`, `FileSystemService`, `ThumbnailService`, `MediaService`,
  `MediaRatingService`, and `VersionService` form the core domain boundary. The event bus and
  background task service provide task IDs, progress, cancellation and retry.
  File-transfer planning and the bounded small/large copy scheduler live in the
  filesystem service rather than the Electron composition root. Image worker
  pools, RAW fallback, video-cover generation, EXIF orientation and rating
  writes are also owned by services rather than `main.cjs` or IPC handlers.
  `ProcessSupervisor` owns child-process lifecycle, health state, bounded
  restart policy and structured lifecycle logging for Python workers, native
  C# helpers and optional component sessions.
- `electron/repositories`: the only JavaScript modules that know Python
  database action names. IPC and services call domain methods instead.
- `electron/plugins`: the optional-plugin catalog and capability mapping.
  Optional capabilities are resolved through `PluginService`; plugin-owned
  workflows, storage and UI remain outside the core application. The
  inspiration-library scene analysis and Office image extraction are bundled
  core workers.
- `electron/native/RecycleBinService.cs`: Windows-only operating-system adapter
  for verified recycle, exact-item restore, and recycle capability probing.
- `electron/thumbnail-pipeline.cjs`: thumbnail scheduling and cache domain.
- `electron/component-registry.cjs`: optional packaged component discovery.
- `python/workspace_db.py`: the catalog/media/version worker. Stable action
  groups live in `workspace_db_domains.py` and schema migrations live in
  `workspace_db_migrations.py`. Deprecated domains attach through the generic
  `python/compatibility/registry.py`; the main database no longer contains
  component-owned tables or action dispatch.
- `python/operations_db.py`: the file-operations journal worker. It owns the
  persistent undo journal and imports legacy `undo_records` once. Deleted media
  bytes are never stored in SQLite.
- `python/compatibility/sample_component_v1/`: the deprecated V1 physical schema,
  legacy extraction, attached-store adapter, workspace actions, and snapshot /
  restore CLI. Development and packaged runtimes discover it through generic
  compatibility metadata and registries.
- `python/tools.py`: source entry point for the shared packaged runtime,
  published as `PhotoFlowImportWorker` (`PhotoFlowImportWorker.exe` on Windows),
  for lightweight Python commands, the thumbnail image server, the built-in
  LibRaw/rawpy RAW decoder, and workspace database processes. They still run
  as isolated child processes while sharing one on-disk Python/Pillow/SQLite
  runtime. OpenCV-based analysis remains in `python/inspiration_tools.py` so
  the large vision dependencies are not duplicated into the core runtime.
- `src/features/workspace`: the project browser, preview, metadata and version
  UI. Selection state is isolated in a controller hook, and the feature compiles
  against the explicit `ProjectWorkspaceApi` preload subset rather than the
  global bridge. Optional component UI is not imported into this package.
- `src/features/tools`: import, birthday, conversion, inspiration, matching and
  video-splitting tools.
- `src/features/inspiration`: the built-in inspiration-library shell and its
  hierarchical navigation. It reuses the workspace file browser.
- `src/features/settings` and `src/features/background-tasks`: application
  settings, generic component management and observable background-task UI.
  `src/App.tsx` is the application shell rather than the previous 4,000-line
  feature container. Component actions are discovered only from `componentHost`
  manifests; component settings live inside component pages.
- `extensions/sample-component/renderer`: independent sample-component application UI.
  It builds separately, ships in the component `ui/` directory, and calls only
  the owner-bound, versioned `photoFlowComponent` RPC allowlist. Existing team
  repositories and version IPC implementations remain a compatibility backend
  during the next extraction stage; they are not exposed to the main renderer.
- Advanced video UI is built into the application: `AdvancedVideoPlayer`,
  Chromium playback, trimming, screenshots, keyboard controls and the
  `videoPlayback` preference all ship in the main renderer. `PlaybackSession`
  and `VideoPlaybackBackend` are application-owned contracts: common web video
  containers use `ChromiumPlaybackBackend`, while the optional advanced
  component contributes only a supervised decoder/rendering backend. A media
  generation records attempted backends and never automatically attempts the
  same backend twice. Startup failure or runtime loss may select the other
  untried backend; only exhaustion of both backends produces the install/repair
  or system-player guidance. Installing the component never installs product UI.
  Configurations saved under the former component-settings key are migrated into
  `videoPlayback` on load.

  The current Electron `video-player-*` IPC names and native input events are a
  compatibility adapter for the optional backend. Removal plan: move native raw
  input translation and screenshot publication into the generic playback broker,
  then retire the legacy advanced-video aliases after all supported installed
  renderers have crossed the compatibility window. New renderer/domain code must
  depend only on the generic backend/session contracts.

## Stable contracts

Existing non-component preload and IPC method names are compatibility contracts. Internal
modules may be replaced without changing renderer behaviour. Long-running file
operations report progress through `workspace-file-operation-progress` and use
the shared `ProjectFileOperationProgress` type.

New cross-domain work follows the ownership, stable-identity, project-content
mutation and versioned-event rules in [DOMAIN_BOUNDARIES.md](DOMAIN_BOUNDARIES.md).
The current direct writers listed there are an explicit migration baseline and
must shrink rather than grow.

Source-package dependency direction and composition-file size budgets are
enforced by [SOURCE_BOUNDARIES.md](SOURCE_BOUNDARIES.md).

Physical database ownership, migration and recovery rules are documented in
[STORAGE_ISOLATION.md](STORAGE_ISOLATION.md).

Child-process ownership and recovery policy are documented in
[PROCESS_SUPERVISION.md](PROCESS_SUPERVISION.md).

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
5. Optional capability-based plugins are discovered through manifests and run
   behind versioned host contracts. Bundled visual tools remain core
   capabilities and use a dedicated visual-tools worker.

`npm run check` is the supported local and Windows-CI gate: lint, TypeScript,
architecture, Electron security, filesystem safety, background tasks, database
migrations and core file interactions. `npm test` runs the core regression
subset, while `npm run test:full` enumerates every `test:*` script. The NSIS
installer behavior test additionally requires electron-builder's NSIS toolchain.

`npm run test:architecture` enforces the important entry-file size, IPC
registration, repository, typed preload and plugin capability contracts.
