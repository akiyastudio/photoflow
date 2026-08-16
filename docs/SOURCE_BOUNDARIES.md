# Source package boundaries

PhotoFlow keeps one desktop distribution while treating renderer features and
main-process layers as source packages. The reviewed dependency graph is stored
in `scripts/source-boundary-policy.cjs` and enforced by
`scripts/test-source-boundaries.cjs`.

## Renderer direction

```text
App.tsx (composition)
  -> features
  -> platform adapters -> contracts/types

feature package -> its own files
                -> reviewed feature contracts only
                -> shared components/types/utilities
```

`src/contracts` cannot import UI or platform implementations. `src/platform`
can depend only on contracts and shared types. A new cross-feature edge fails
the boundary test until the dependency is moved behind a public contract or
the architecture policy is explicitly reviewed.

The current shared `components` directory still depends on background-task,
metadata, versioning and workspace models. These edges are a shrink-only
baseline; new feature dependencies are rejected.

## Main-process direction

```text
main.cjs -> IPC registrars -> services -> repositories/workers
                         \-> contracts
```

The composition root imports business capabilities through
`electron/domains/<domain>/public.cjs`. Renderer consumers of versioning use
`src/features/versioning/public.ts`; direct imports of versioning internals are
rejected by the boundary test. The same public-entry rule is the baseline for
new domain packages.

- Contracts do not import implementations.
- Repositories do not import services or IPC modules.
- Services do not import IPC modules or the composition root.
- A top-level IPC registrar does not import another registrar.
- The existing version registrar to version-tracking registrar edge is a
  shrink-only compatibility exception.
- Domain-specific helper modules may live below their registrar directory,
  such as `electron/modules/workspace/`.

## Composition budgets

The entry files have shrink-only line budgets. New behavior belongs in a
feature model, view, service or domain helper instead of growing `App.tsx`,
`ProjectWorkspace.tsx` or `workspace-ipc.cjs` again.
