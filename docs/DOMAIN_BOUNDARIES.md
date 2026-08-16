# PhotoFlow domain ownership and contract baseline

This document is normative for new code. It is the first migration stage from
the modular desktop monolith toward independently evolvable subsystems. The
machine-readable counterpart is `electron/contracts/domain-ownership.cjs`.

## Ownership rule

Every mutable fact has exactly one owning domain. Other domains query the owner
or consume a versioned event; they do not update the owner's tables or files.

| Domain | Authoritative state |
| --- | --- |
| `shell` | Windows, navigation, application configuration and component lifecycle |
| `workspace` | Workspace identity, project catalog/status and virtual paths |
| `file-operations` | Project-content mutations, operation journal and undo journal |
| `import` | Import plans, staging manifests and resumable checkpoints |
| `media` | Media index, metadata, ratings, thumbnails and preview cache |
| `versioning` | Version graph, progress relations and tracking sessions |
| `backup-archive` | Backup snapshots, retention, restore plans and archive placement |
| `team-retouch` | Team identities, assignments, patches and recomposition jobs |
| `inspiration-tools` | Inspiration metadata and transient tool jobs |
| `telemetry` | Consent-filtered telemetry, crashes and feedback queue |

Owning state does not grant unrestricted filesystem access. A domain may write
its application-data store, cache or staging directory. Only `file-operations`
may commit mutations to customer project content.

## Stable identities

- A workspace ID is the persisted lowercase hexadecimal value in
  `.photoflow-workspace-id`. Moving the workspace must not change it.
- Projects and all new cross-domain entities use canonical UUIDs. A path,
  project name, array index or renderer page ID is never a business identity.
- IPC and events carry IDs alongside paths during migration. Consumers compare
  IDs and treat paths as mutable attributes.
- IDs are never recycled after deletion.

Legacy rows keep their current IDs. A migration must map any non-UUID legacy ID
to a UUID before that entity is published across a new domain contract.

## Project-content write entry

The target write flow is:

```text
caller -> versioned file command -> File Operations -> durable mutation
       -> file-operations.project-content.mutated.v1 -> consumers
```

Allowed commands are `copy`, `move`, `rename`, `trash`, `restore`,
`create-directory`, `create-file`, `commit-import` and `commit-version`.
Every command must have a stable `commandId` and be idempotent. Import,
versioning, archive and team-retouch may prepare content in owned staging
directories but must use this entry to publish it into a project.

The runtime command envelope is defined in
`electron/contracts/project-content-commands.cjs`; the matching renderer type
is `ProjectContentCommand` in `src/contracts/domain-events.ts`.

The current monolith still has project-content writers listed in
`LEGACY_PROJECT_CONTENT_WRITERS`. That list is migration debt, not permission
for new writers. Entries are removed as their operations move behind the file
command boundary; additions require an architecture decision and test update.

## Event envelope

New cross-domain events use `domain.entity.action.vN` and the runtime validator
in `electron/contracts/domain-events.cjs`:

```json
{
  "schemaVersion": 1,
  "eventId": "590aeac2-88c7-4f31-90b1-009698ec879c",
  "type": "file-operations.project-content.mutated.v1",
  "source": "file-operations",
  "occurredAt": "2026-08-16T00:00:00.000Z",
  "aggregate": { "type": "project", "id": "7d53f616-c690-4e1d-8775-ef47bec8664d" },
  "workspaceId": "0123456789abcdef01234567",
  "projectId": "7d53f616-c690-4e1d-8775-ef47bec8664d",
  "payload": {}
}
```

Events are immutable facts. Producers never change a published event version;
they introduce a new version. Consumers must tolerate unknown payload fields.
Delivery is at least once, so consumers deduplicate by `eventId`.

The in-process event bus retains `emit` for private lifecycle notifications.
Cross-domain events use `publish`, which validates the envelope and emits both
`domain-event` and the exact versioned event type.

## Pull-request checklist

1. Identify the owning domain for every new mutable fact.
2. Use a stable ID rather than a name or path for cross-domain references.
3. Do not add a project-content writer outside `file-operations`.
4. Version every cross-domain command and event.
5. Add contract tests for producers and consumers.
6. Document migration, idempotency and failure recovery behavior.
