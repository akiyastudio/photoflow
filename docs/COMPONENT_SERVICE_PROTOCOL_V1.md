# Component Service Protocol V1

Component renderer code remains sandboxed in a host-owned `WebContentsView`. A component may additionally declare a supervised service in `componentHost.service`; Electron main launches that entry as a child process and never `require`s or imports component code.

## Manifest boundary

The service declaration contains a protocol version, runtime, platform entrypoint, versioned RPC method allowlist, and requested host-capability allowlist. Entries must resolve to regular, non-symlink files inside the installed component root. Unknown capabilities, unversioned methods, path traversal, absolute external paths, and unsupported runtimes are rejected while discovering the component.

The currently supported host capability vocabulary is intentionally small:

- `project.media.list.v1`
- `project.media.read.v1`
- `project.output.authorize.v1`
- `version.register.v1`
- `tasks.report.v1`
- `component.settings.v1`
- `component.storage.v1`
- `dialogs.open.v1`
- `component.lifecycle.v1`

Declaring a capability does not make it available automatically. Electron main must register a generic implementation, and the broker checks both the installed manifest grant and the bound component-page request before every call.

## Process protocol

Transport is newline-delimited JSON over private stdin/stdout pipes. The service first emits `ready`, then accepts `request` frames. A service may issue a `capability` frame only while handling a known parent request. The host replies with `capability-response`; the service completes the renderer invocation with `response`.

Raw workspace paths are retained in the host-bound context and are not sent in a service request. The service receives stable project identity only and must use an explicitly granted host capability for media, output, version, task, setting, storage, picker, or lifecycle access. Arbitrary renderer IPC channels do not exist in this protocol.

Frames and payloads are capped at 2 MiB. The launched process receives a minimal OS environment rather than the host environment, preventing unrelated credentials from being inherited. Unexpected, invalid, or oversized frames recycle the process. In-flight requests fail on exit instead of being replayed, which preserves at-most-once mutation semantics; callers must retry through an operation-specific idempotency key once a component domain defines one.

## Data and migration rule

Service extraction does not authorize moving or deleting component data. A domain may keep its existing physical database location during migration, but only one service generation may own the writer. Component uninstall removes code only. Snapshot, restore, health, and legacy-database adoption remain explicit host lifecycle capabilities until the generic domain lifecycle contract is complete.

## Current migration status

The protocol, manifest validation, capability broker, service launcher, renderer routing fallback, supervision, and boundary tests are implemented. Team-retouch declares a Node service and owns project snapshot/registration/removal, identity save/assignment/group confirmation/deletion, person exclusion, detection, patch CRUD/upload, and merge. Those routes no longer have main-process compatibility handlers or mappings. Detection and merge execute only through the component-owned algorithm runtime; file mutations use authorization, staging/compensation, and a component command log, while merged versions are registered through the generic host capability. Identity suggestion/completion, workflow, return, and advanced-runtime routes remain on their compatibility handlers and must not be described as extracted.
