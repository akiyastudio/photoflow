# Team Retouch component

This directory is the complete source boundary for the optional Team Retouch package:

- `renderer/` builds the isolated Component Host page.
- `team_retouch.py`, `patch_merge.py`, `identity_engine.py`, and `advanced_bridge.py` provide the packaged backend and algorithms.
- `models/` and the model inputs declared by `scripts/build-components.cjs` are copied into the native runtime.
- `advanced/` and the advanced installer scripts are shipped by the component package.
- `component.template.json` owns the package identity, user-facing copy/icon, required files, and `componentHost` declaration.

Build order is fixed: `npm run build:team-retouch-renderer` runs first, then the native runtime is assembled, then the renderer output is copied to `ui/`, and finally the component ZIP is created. Installed manifests never reference repository source or the main application build.

The page can access only `window.photoFlowComponent`. Its RPC method names are versioned and owned by `team-retouch`; workspace/project identity is supplied by the host-bound component instance. The current host-side handlers are a compatibility backend for the existing single-write database and workspace-data layout, not the final extraction boundary.
