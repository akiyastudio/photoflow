const ALLOWED_RENDERER_FEATURE_EDGES = Object.freeze([
  'app->background-tasks',
  'inspiration->file-browser',
  'inspiration->workspace',
  'settings->tools',
  'workspace->background-tasks',
  'workspace->file-browser',
  'workspace->metadata',
  'workspace->plugins',
  'workspace->tools',
  'workspace->versioning',
]);

const ALLOWED_COMPONENT_FEATURE_EDGES = Object.freeze([
  'components->background-tasks',
  'components->metadata',
  'components->versioning',
  'components->workspace',
]);

const ENTRY_FILE_BUDGETS = Object.freeze({
  'src/App.tsx': 950,
  'src/features/workspace/ProjectWorkspace.tsx': 7050,
  'electron/modules/workspace-ipc.cjs': 3100,
});

const ALLOWED_IPC_REGISTRAR_EDGES = Object.freeze([
  'electron/modules/versions-ipc.cjs->electron/modules/version-tracking-ipc.cjs',
]);

module.exports = { ALLOWED_COMPONENT_FEATURE_EDGES, ALLOWED_IPC_REGISTRAR_EDGES, ALLOWED_RENDERER_FEATURE_EDGES, ENTRY_FILE_BUDGETS };
