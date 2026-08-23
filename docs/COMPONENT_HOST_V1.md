# Component Host V1

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

The host binds each SDK request to the exact component `webContents` sender. `window.photoFlowComponent` exposes only `contractVersion`, `getContext()`, `rpc()`, `onActivate()`, and `onDeactivate()`. V1 has no business RPC methods yet; unknown methods fail closed. It never exposes `ipcRenderer` or the main renderer's `electronAPI`.

The page key is `componentId + normalized workspace path + projectId`. Repeated toolbar clicks focus the existing page. Closing a page destroys its view; closing the last page for a project or deleting/closing the project closes every component view for that project. Bounds are supplied by a host-owned empty surface in the application renderer; component DOM is never mounted into PhotoFlow's React tree.

## Current boundary

The real `WebContentsView` integration, sender binding, layout, focus, and teardown are implemented. Component Host V1 does not yet provide domain/business RPC methods or a first-party UI component package. The existing package installer continues to serve cataloged native V1 components; dynamically discovered UI packages can be registered from the component root, while a generalized signed UI-package installer remains future work.
