const ALLOWED_RENDERER_FEATURE_EDGES = Object.freeze([
  'app->background-tasks',
  'components->app',
  'components->background-tasks',
  'inspiration->app',
  'inspiration->components',
  'inspiration->file-browser',
  'inspiration->workspace',
  'search->components',
  'settings->app',
  'settings->components',
  'settings->tools',
  'workspace->background-tasks',
  'workspace->app',
  'workspace->components',
  'workspace->file-browser',
  'workspace->metadata',
  'workspace->tools',
  'workspace->versioning',
]);

const REVIEWED_FEATURE_COUPLED_SHARED_COMPONENTS = Object.freeze([
  'src/components/MediaThumbnail',
]);

const ALLOWED_COMPONENT_FEATURE_EDGES = Object.freeze([
  'components->app',
  'components->background-tasks',
  'components->metadata',
  'components->versioning',
  'components->workspace',
]);

const ENTRY_FILE_BUDGETS = Object.freeze({
  'src/App.tsx': 950,
  'src/features/workspace/ProjectWorkspace.tsx': 7680,
  'electron/modules/workspace-ipc.cjs': 3200,
});

const ALLOWED_IPC_REGISTRAR_EDGES = Object.freeze([
  'electron/modules/versions-ipc.cjs->electron/modules/version-tracking-ipc.cjs',
]);

module.exports = { ALLOWED_COMPONENT_FEATURE_EDGES, ALLOWED_IPC_REGISTRAR_EDGES, ALLOWED_RENDERER_FEATURE_EDGES, ENTRY_FILE_BUDGETS, REVIEWED_FEATURE_COUPLED_SHARED_COMPONENTS };
