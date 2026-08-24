# PhotoFlow component development tutorial

PhotoFlow calls optional packages **components**. “Plugin” is retained in this file name for discoverability; new packages must use Component Host V2 and must not import PhotoFlow renderer or Electron main-process code.

## Quick start

1. Copy `examples/hello-component` to a directory named after your component ID.
2. Keep `componentHost.contractVersion` and both compatibility values at `2` while developing against this API.
3. Add one `workspace.toolbarAction`, one linked `component.fullPage`, a package-local UI entry, and a service entry.
4. Declare every service RPC method, Host capability, permission, and emitted event. Undeclared access fails closed.
   For an upgrade from an installed Host V1 package with the same component ID, optionally declare `componentHost.migrations.legacyStorageV1` and/or `legacyOutputV1`; never add component tables or path fields to Host code.
5. Run `node scripts/mock-component-service.cjs path/to/service.cjs` to exercise the newline-delimited service protocol without Electron.
6. Place the directory in PhotoFlow's user component folder, or add it under `extensions/` for a source checkout. A packaged install uses `component.json`; source development may use `component.template.json` plus the existing component build flow.

The complete sample contains a static page and a Node service. Its page calls only `window.photoFlowComponent`; its service asks the host for a media page. `component-sdk/index.d.ts` supplies request/result/error/event/JSONL frame mappings for every V2 capability, while `component-sdk/service.cjs` provides `callHost`, `acceptFrame`, and `failAll` for service backends.

## Package layout

```text
hello-component/
  component.json
  service.cjs
  ui/index.html
  ui/icon.svg          # optional, PNG or passive SVG only
```

Paths in the manifest are package-relative. Symlinks, traversal, remote page/icon URLs, active SVG content, missing files, and unknown contributions reject the entire UI registration. The component does not select its preload.

## UI tutorial

```ts
import { host, assertHostApiV2 } from '../../component-sdk/index.js';

const context = await host.getContext();
assertHostApiV2(context);
const page = await host.rpc('my-component.load.v1', { cursor: null });
const stop = host.onEvent('my-component.progress.v1', update => render(update));
window.addEventListener('pagehide', stop, { once: true });
```

The UI runs in a sandboxed `WebContentsView` with Node integration, webviews, navigation, new windows, and browser permissions disabled. Use the resolved light/dark theme from context and listen for theme/context changes. Keep controls keyboard reachable, provide visible focus, label form fields, respect reduced motion, and do not assume the host page remains active. Release timers and subscriptions on deactivation or page teardown.

The renderer calls component-owned RPC methods, not Host capabilities directly. The component service is the backend protocol endpoint and requests only its manifest-granted Host capabilities.

## Backend service tutorial

The service communicates over UTF-8 JSON Lines on stdin/stdout:

1. Emit `{ "type":"ready", "protocolVersion":1 }` after initialization.
2. Receive a `request` with an opaque request ID, a declared versioned method, a JSON payload, and a path-free project context.
3. Return a `response`, or emit a `capability` tied to the request's `parentId` and wait for `capability-response`.
4. Keep logs on stderr. Stdout is protocol-only.

See `examples/hello-component/service.cjs` for a complete implementation. Ordinary synchronous requests time out after 60 seconds and frames/payloads are limited to 2 MiB. Long work should start a `tasks.v2` operation, checkpoint frequently, return control to the UI, and resume from the last checkpoint after cancellation or restart.

## A safe media-to-version flow

1. Page through `project.media.page.v2`.
2. Use `variants:[]` for stable media metadata. Resolve only the needed `thumbnail`, `preview`, or `original` when pixels or a URL are actually needed.
3. Exchange the returned short-lived, single-use input token with `project.input.tokens.v2` when the service needs a private file copy.
4. Call `project.output.v2` `stage`; write below the returned private staging directory; register each file with `write`; then `validate`.
5. Call `commit` with a stable idempotency key. The host publishes only declared relative targets under the bound project.
6. Optionally call `version.create.v2` with the returned commit/artifact IDs and another stable idempotency key.
7. Call `rollback` for an abandoned stage.

Stages persist their metadata and registered files for 24 hours, so a restarted Host can resume `validate`, `commit`, or `rollback`. Keep the returned `stageId`, `commitId`, and artifact IDs rather than private paths. A committed artifact can be opened or revealed through `dialogs.v2`; `materializeOwned` can verify and import it into private storage during migration. Arbitrary output paths are never accepted.

Use `component.media.v2` for files owned under `component.storage.v2`, and `project.progress.v2` to list/create image or video progress nodes and record generic source relationships. Component-private media requests take only a relative path. Project media pages and variants include Host-managed external/virtual paths while preserving their virtual identity.

Replacing project output is explicit: register `replace:true`, `previousCommitId`, `previousArtifactId`, and `expectedDigest` in the stage write. The Host replaces only a target owned by that prior committed receipt and journals the old bytes for multi-file rollback. Never implement overwrite by deleting the target yourself.

Never persist project paths as component identity. Persist PhotoFlow IDs and component-owned metadata. A token, cursor, stage, commit, or artifact ID is opaque and scoped to one component and project.

## Testing and release

- `npm run test:component-host-v2` first type-checks the SDK, then checks negotiation, permissions, managed-external and component-private media, persistent stage expiry/recovery, commit journals and controlled replacement, crash-safe version idempotency, progress, tasks, safe dialogs, events, the production media repository/service composition, and the service mock.
- `npm run test:component-host`, `npm run test:component-service`, `npm run test:electron-security`, and `npm run test:architecture` cover isolation and compatibility.
- Validate the manifest against `electron/contracts/schemas/component-manifest-v2.schema.json` before packaging.
- Package only built UI/service/runtime files, calculate hashes for any declared lifecycle action, install into a clean profile, test cancellation and restart, then test upgrade and downgrade with real V1 data.
- Increase the component business version for every release. Increase an RPC/event `.vN` only for breaking semantics; add the new version alongside the old one during migration.

Host V1 components continue through a deprecated compatibility adapter. New components must not request V1 team/business capabilities or depend on compatibility paths.
