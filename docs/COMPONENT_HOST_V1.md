# Component Host V1

> Deprecated for new development. Installed V1 components continue through the isolated compatibility adapters. Use [PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md) and [PLUGIN_HOST_API.md](PLUGIN_HOST_API.md) for Component Host V2.

Component Host V1 is the only supported path for optional component UI. PhotoFlow reads a component's `component.json`, renders one host-owned button in the dedicated **UI 组件** group at the top of a project folder workspace, and opens one independent full-page component tab. A component cannot contribute React code to PhotoFlow's renderer.

V1 deliberately does not support file-list decorations, context-menu items, media-preview overlays, ordinary settings pages, DOM injection, or advanced-video playback. Existing native `apiVersion: 1` components remain on the legacy process-capability path when `componentHost` is absent.

## Manifest contract

```json
{
  "apiVersion": 1,
  "id": "example-component",
  "version": "1.2.3",
  "componentHost": {
    "contractVersion": 1,
    "compatibility": {
      "minHostApiVersion": 1,
      "maxHostApiVersion": 1
    },
    "contributions": [
      {
        "type": "workspace.toolbarAction",
        "id": "open",
        "label": "示例组件",
        "pageId": "main"
      },
      {
        "type": "component.fullPage",
        "id": "main",
        "title": "示例组件",
        "entry": "ui/index.html"
      }
    ]
  }
}
```

The host discovers manifests under component roots dynamically; UI component IDs and business versions are not compiled into the host catalog. V1 requires exactly one toolbar action linked to exactly one full page. Unknown contribution types, incompatible API ranges, malformed IDs, duplicate contributions, missing files, symlinks, and entries outside the component root reject the complete UI registration.

## Isolation and lifecycle

Every page runs in a host-owned `WebContentsView` with `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, and `webviewTag:false`. Window creation, navigation, webviews, and permissions are denied. The component entry never chooses its preload.

The host binds each SDK request to the exact component `webContents` sender. `window.photoFlowComponent` exposes only `contractVersion`, `getContext()`, `rpc()`, `onEvent()`, `onActivate()`, and `onDeactivate()`. RPC methods are versioned, owned by one component ID, registered from an explicit mapping, and filter payload fields before dispatch. Workspace and project identity come from the bound page instance. Unknown methods, event topics, fields, senders, and component owners fail closed. The SDK never exposes `ipcRenderer`, arbitrary channels, arbitrary filesystem primitives, or the main renderer's `electronAPI`.

The page key is `componentId + normalized workspace path + projectId`. Repeated toolbar clicks focus the existing page. Closing a page destroys its view; closing the last page for a project or deleting/closing the project closes every component view for that project. Bounds are supplied by a host-owned empty surface in the application renderer; component DOM is never mounted into PhotoFlow's React tree.

## First-party team-retouch package

`extensions/team-retouch` is the first first-party UI package. Its manifest, copy, icon, independent renderer source, Python backend, models, algorithms, and advanced-environment scripts live with the component package inputs. `npm run build:team-retouch-renderer` emits a standalone static renderer. `scripts/build-components.cjs` always builds it before the native runtime and copies it into the package's `ui/` directory. Production `component.json` points only to `ui/index.html` inside the installed component.

The main React renderer contains no team-retouch manager, identity manager, step UI, toolbar action, context-menu action, embedded panel, settings contribution, or `workspace-team-*` preload API. It renders only the manifest-derived toolbar button and host-owned page chrome. The component page owns detection, identity, workflow, return, merge, and settings UI.

Every manifest-declared `team.*` RPC is implemented by `extensions/team-retouch/service.cjs`; none maps to a `workspace-team-*` renderer IPC handler. Detection, identity inference, recropping, merging, return ingestion, and post-install advanced-runtime probing run inside the component service. The application process does not compose a team-retouch repository, database worker, project-purge command handler, or algorithm invocation.

The advanced WSL environment has its own `advancedRuntime.apiVersion`, independent from the component release version. New offline packages are accepted when that API version matches. Packages created before the API field existed are accepted only when their component version appears in the reviewed `compatibleLegacyComponentVersions` manifest list, so UI/service releases do not force a multi-gigabyte WSL rebuild without weakening compatibility checks.

The remaining host references are compatibility and trust-boundary identifiers, not business implementations:

- `electron/main.cjs` and `electron/services/backup-service.cjs` retain the `team-retouch.sqlite3` path/domain name so backup, restore, reset, and recovery continue to preserve existing component data.
- `electron/modules/system-ipc.cjs` retains the component package root and advanced-package filename pattern for validated install-package discovery and cleanup.
- `electron/services/component-lifecycle-service.cjs` retains the signed advanced-package pattern and lifecycle path policy; the component service performs the runtime probe.
- `electron/services/component-project-capabilities.cjs` retains the `team-retouch` owner checks that bind storage, project media/output, dialogs, settings, and task events to the installed manifest and current project. These checks grant bounded host resources and do not implement team algorithms or persistence.

Uninstalling the component does not delete data; a missing or malformed component only removes its dynamic action.
