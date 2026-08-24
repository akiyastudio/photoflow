# PhotoFlow Component Host API V2 specification

This document is normative for new components. The runtime manifest validator is `electron/component-host-contract.cjs`; machine-readable constraints are in `electron/contracts/schemas/`; public types are in `component-sdk/index.d.ts`.

## Version negotiation and deprecation

PhotoFlow currently supports Host API versions 1–2 and chooses the highest version in the component's inclusive compatibility range. `componentHost.contractVersion:2` requires negotiated Host API 2 and an explicit permission list. Host API 1 remains available only for installed legacy packages.

RPC methods, capabilities, and events end in `.vN`. Published meanings are immutable; compatible fields may be added and consumers must ignore unknown fields. A breaking change gets a new method/event version. A deprecated version remains for at least one normal component migration window and is documented before removal. V1 business adapters under `electron/compatibility/` are deprecated, are not public API, and receive no new methods.

The renderer bridge `window.photoFlowComponent.contractVersion` remains `1`; this is the small preload ABI, not the negotiated Host API. Read `context.hostApiVersion` for Host API negotiation.

## Manifest and permissions

V2 requires `contractVersion`, compatibility range, contributions, service protocol/runtime/entrypoint, versioned RPC allowlist, Host capability allowlist, and permission allowlist. An empty events array is explicit. Capabilities require the matching permission:

| Capability | Permission | Purpose |
| --- | --- | --- |
| `project.media.page.v2` | `project.media.read` | Bounded recursive media pages |
| `project.media.variants.v2` | `project.media.read` | Explicit thumbnail/preview/original variants |
| `project.input.tokens.v2` | `project.input.read` | Materialize a restricted input into private storage |
| `project.output.v2` | `project.output.write` | Stage, register/write, validate, commit, rollback |
| `version.create.v2` | `project.version.create` | Create a generic version from a committed artifact |
| `component.storage.v2` | `component.storage` | Component-private data and SQLite locations |
| `component.settings.v2` | `component.settings` | Version-independent private JSON settings |
| `tasks.v2` | `tasks` | Progress, checkpoint, cancellation and resume handshake |
| `dialogs.v2` | `dialogs` | Host-owned confirmation and bounded file selection |
| `component.events.v2` | `events` | Declared versioned component events |
| `component.lifecycle.v2` | `component.lifecycle.read` | Negotiated version, grants and lifecycle state |
| `component.media.v2` | `component.media` | Variants/open/reveal below component-private storage |
| `project.progress.v2` | `project.progress` | List/create progress nodes and register source relations |

Running a declared lifecycle action additionally requires `component.lifecycle.manage`. The broker still checks `component.lifecycle.read` for `describe`; the lifecycle service checks the stronger permission before `preflight`, `install`, `repair`, or `uninstall`.

Permissions are checked when parsing the manifest and again for every capability invocation. Component ID, version, project ID/name/status, and scope come from the bound host view; request payloads cannot replace them.

## Capability contracts

### Project media

`project.media.page.v2` accepts `pageSize` (1–200), opaque `cursor`, and `kinds` (`image`, `raw`, `video`). A cursor expires after five minutes, is bound to one component/project, and must not be decoded or persisted. Each page inspects at most 1,000 entries and does not follow symlinks. Host-managed external files/folders participate using their virtual relative paths; unmanaged external paths remain denied.

`project.media.variants.v2` accepts either `{photoId, versionId}` or `{relativePath}` plus a subset of `thumbnail`, `preview`, `original`. Thumbnail is a generated 320-pixel derivative and is never replaced by a normal original URL. Preview is a generated 1,600-pixel derivative. Original is explicitly marked `derived:false`. `variants:[]` is metadata-only: it creates no URL grant, thumbnail request, or input token. A request containing `original` also carries a ten-minute, single-use input token for explicit materialization.

`project.input.tokens.v2 {action:"materialize",token}` consumes the token and copies the input into component-private storage. Tokens are scoped to component, workspace, and project, and are invalid after use or expiry. Raw paths are never accepted from the renderer.

### Private storage and settings

`component.storage.v2` returns component-owned locations under workspace application data, never a project-content write grant. A component owns its schema and migrations; the host does not inspect its tables. A V2 manifest may declare `migrations.legacyStorageV1:true`; the Host then copies the same component ID's known V1 data root/database transactionally, preserves the V1 source for rollback/old-package compatibility, and returns a source-root/digest adoption receipt so the component can safely rewrite its own stored paths. Cross-domain references use stable project/media/version IDs.

`component.media.v2` accepts only a relative file below that private storage and an action: `variants`, `open`, or `reveal`. Variants have the same explicit derivative semantics as project media. The result contains URLs and an opaque media ref, never a caller-supplied absolute path. Deletion and invalidation remain the component database's responsibility.

`component.settings.v2` supports `get`, `replace`, and shallow `merge`. Settings and checkpoints are JSON objects up to 256 KiB. Updates are atomic and return a monotonically increasing revision. Components tolerate unknown retained keys and migrate their own old shapes.

### Output transaction and versions

`project.output.v2` actions are:

- `stage`: creates a private stage and returns its path to the supervised backend.
- `write`: registers an existing `sourceName` below the stage, copies an input token, or accepts inline base64 up to 8 MiB; it binds an `outputRelativePath` and returns an artifact ID.
- `validate`: rejects empty, linked, escaped, missing, or oversized stages. A stage is limited to 2,000 files and 2 GiB.
- `commit`: requires an ID-shaped idempotency key, refuses overwrite, atomically publishes files below the bound project, rolls back files created by a failed multi-file commit, and returns commit/artifact IDs. Retrying the same key returns the original result.
- `rollback`: recursively removes only the component-private stage and is safe to call for abandoned work.
- `adoptLegacyV1`: when `migrations.legacyOutputV1:true` is declared, creates a one-time ownership receipt for bounded, existing project-relative outputs from the same component's V1 installation.
- `materializeOwned`: verifies a committed output receipt/current digest and copies that artifact into component-private storage, allowing component-owned schema migration without retaining a project path.
- `delete`: removes only a current output whose prior commit/artifact IDs and expected digest still match, and writes an idempotent deletion receipt.

Stage state is not memory-only. The Host atomically persists stage metadata and its registered file list outside the writable payload subdirectory, binds it to component/workspace/project, and enforces an immutable `createdAt + 24h` expiry on every non-terminal action. Expiry deletes only that exact validated stage directory.

Before publishing, `commit` writes a `prepared` receipt containing a stable commit ID, target relative paths, artifact IDs, sizes, SHA-256 digests, and per-file publication state. It journals after every atomic publication and changes the receipt to `committed` only when all outputs exist with matching digests. Restart recovery reuses only matching published bytes. A conflict rolls back all still-matching Host outputs and preserves any file changed by the user. Failure to finalize the receipt rolls back the complete multi-file publication and removes its unusable journal.

Controlled replacement requires `replace:true`, `previousCommitId`, `previousArtifactId`, and `expectedDigest` on `write`. The prior committed receipt must own the same target and the current bytes must still match. Replacement backups live in the expiring stage until the new multi-file receipt commits. Legacy adoption is generic, manifest-gated, same-component/project scoped, project-relative, digest checked, and contains no component business rules.

Project-content targets are relative; absolute paths and `..` are invalid. A component cannot commit outside its bound project or use a stage/commit from another component/project.

`version.create.v2` consumes a committed artifact plus photo/parent-version IDs. It resolves `commitId` directly from the committed receipt after restart, without requiring `commit` replay. The version ID is deterministically derived from bound scope plus idempotency key and a `prepared` version receipt is persisted before the database call. A retry first searches the real photo versions for that stable ID, preventing duplicate versions even if the Host crashed or the final receipt write failed.

`project.progress.v2` supports `list`, `create`, and `relate`. It returns stable progress/edge IDs without folder paths. Create accepts a project virtual `relativePath`, `image`/`video` kind, version key, structural parent ID, and optional generic `sourceProgressIds`; the versioning repository validates graph roles and cycles.

### Tasks, cancellation and recovery

`tasks.v2` actions are `start`, `report`, `status`, `cancel`, `resume`, `complete`, and `fail`. `operationId` is stable and scoped to component/project. Progress is 0–100. A report may save a JSON checkpoint. Cancellation is cooperative: after the response reports `cancelled:true`, the service stops work, leaves project content untouched, and either rolls back its stage or retains only private resumable data. `resume` starts/rebinds the operation using the supplied or returned checkpoint. Repeating terminal transitions is harmless.

Do not hold a synchronous service request open for a long job. The ordinary service timeout is 60 seconds. Existing reviewed V1 long methods retain their legacy four-hour compatibility timeout; this exception does not apply to new APIs.

### Safe dialogs, events and lifecycle

`dialogs.v2` supports `confirm`, `openFiles`, `openOutput`, and `revealOutput`. File selection returns restricted tokens, not caller-selected output paths. Output actions accept only a committed `{commitId, artifactId}` whose receipt and current digest still match. Extension filters are normalized and limited to 64. At most 2,000 selections are returned.

`component.events.v2` emits only topics declared in `service.events`, with a versioned topic and a JSON object up to 256 KiB. Delivery is best effort and at least once; consumers make handlers idempotent. Events do not carry filesystem paths or mutate host state.

`component.lifecycle.v2 {action:"describe"}` reports the installed component version, negotiated Host API, permissions, declared events/actions, and state. With `component.lifecycle.manage`, `preflight`, `install`, `repair`, and `uninstall` execute only the matching manifest-declared package-local PowerShell entry after installed-version, root, symlink, and SHA-256 verification. Payload commands, arguments, and paths are rejected. The verified script receives only fixed `PHOTOFLOW_COMPONENT_LIFECYCLE_ACTION`, component ID, and component version environment values plus a small OS environment allowlist. Page creation/destruction and project close remain host-owned.

## Protocol, limits and errors

UI RPC and service JSONL frames are JSON objects and limited to 2 MiB. Method and event names are bounded and versioned. Unknown methods, fields at strict manifest boundaries, senders, capabilities, permissions, stages, tokens, and event topics fail closed. Service stdout contains one JSON frame per line; logs use stderr. `component-host-api-v2.schema.json` has one method-discriminated request/result branch per capability; `component-service-protocol-v1.schema.json` specifies JSONL frames.

Stable host error codes are:

- `COMPONENT_HOST_INVALID_REQUEST`, `COMPONENT_HOST_PERMISSION_DENIED`, `COMPONENT_HOST_NOT_FOUND`
- `COMPONENT_HOST_TOKEN_EXPIRED`, `COMPONENT_HOST_TOKEN_SCOPE`, `COMPONENT_HOST_LIMIT_EXCEEDED`
- `COMPONENT_HOST_VARIANT_UNAVAILABLE`, `COMPONENT_HOST_CONFLICT`, `COMPONENT_HOST_CANCELLED`
- `COMPONENT_HOST_TIMEOUT`, `COMPONENT_HOST_SERVICE_EXITED`, `COMPONENT_HOST_INTERNAL`

Errors include a human-readable message and may include `retryable`. Retry only when marked retryable or for a documented idempotent operation. Never retry a mutation with a new idempotency key after an ambiguous result.

## Data ownership, security and compatibility

The host owns projects, media index/variants, versions, file safety, task center, component lifecycle, and the permission ledger. The component owns its private storage, settings schema, algorithms, UI state, and business entities. Only the host publishes project content. Neither side updates the other's database.

V1 component data and protocols are left in place. The deprecated adapters translate only reviewed old routes and may access the old component-owned store; V2 code never imports them. Removing a component's source directory must not prevent the host, SDK, schemas, example, or generic tests from building. New code must pass the architecture assertion that generic component host files contain no component business table or field names.
