const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DOMAIN_IDS,
  DOMAIN_OWNERSHIP,
  LEGACY_PROJECT_CONTENT_WRITERS,
  PROJECT_CONTENT_COMMANDS,
  PROJECT_CONTENT_MUTATION_OWNER,
  assertProjectContentMutationOwner,
} = require('../electron/contracts/domain-ownership.cjs');
const {
  assertDomainEvent,
  assertStableEntityId,
  assertStableWorkspaceId,
  createDomainEvent,
  parseEventType,
} = require('../electron/contracts/domain-events.cjs');
const {
  assertProjectContentCommand,
  createProjectContentCommand,
} = require('../electron/contracts/project-content-commands.cjs');
const { createEventBus } = require('../electron/services/event-bus.cjs');

assert.strictEqual(new Set(DOMAIN_IDS).size, DOMAIN_IDS.length, 'domain IDs must be unique');
assert.deepStrictEqual(Object.keys(DOMAIN_OWNERSHIP).sort(), [...DOMAIN_IDS].sort(), 'every domain must declare ownership');
for (const [domain, definition] of Object.entries(DOMAIN_OWNERSHIP)) {
  assert(definition.owns.length > 0, `${domain} must own at least one capability`);
  assert(definition.storage.length > 0, `${domain} must declare its storage boundary`);
}
assert.strictEqual(PROJECT_CONTENT_MUTATION_OWNER, 'file-operations');
assert(PROJECT_CONTENT_COMMANDS.includes('commit-import') && PROJECT_CONTENT_COMMANDS.includes('commit-version'));
assert.strictEqual(assertProjectContentMutationOwner('file-operations'), 'file-operations');
assert.throws(() => assertProjectContentMutationOwner('versioning'), /owned by file-operations/);

const eventId = '590aeac2-88c7-4f31-90b1-009698ec879c';
const projectId = '7d53f616-c690-4e1d-8775-ef47bec8664d';
const workspaceId = '0123456789abcdef01234567';
assert.strictEqual(assertStableEntityId(projectId), projectId);
assert.strictEqual(assertStableWorkspaceId(workspaceId.toUpperCase()), workspaceId);
assert.throws(() => assertStableEntityId('project-name'), /canonical UUID/);
assert.throws(() => assertStableWorkspaceId('C:\\workspace'), /persisted workspace identity/);
assert.deepStrictEqual(parseEventType('media.thumbnail.generated.v1'), {
  domain: 'media', entity: 'thumbnail', action: 'generated', version: 1,
});
assert.throws(() => parseEventType('unknown.entity.changed.v1'), /Unknown domain/);

const event = createDomainEvent({
  eventId,
  type: 'file-operations.project-content.mutated.v1',
  source: 'file-operations',
  occurredAt: '2026-08-16T00:00:00.000Z',
  aggregate: { type: 'project', id: projectId },
  workspaceId,
  projectId,
  payload: { commandId: eventId, operation: 'move', affectedFileIds: [], affectedPaths: [] },
});
assert(Object.isFrozen(event) && Object.isFrozen(event.aggregate) && Object.isFrozen(event.payload));
assert.strictEqual(assertDomainEvent(event).type, event.type);
assert.throws(() => createDomainEvent({ ...event, source: 'workspace' }), /domain must match source/);

const command = createProjectContentCommand({
  commandId: eventId,
  requester: 'import',
  operation: 'commit-import',
  workspaceId,
  projectId,
  payload: { stagedPath: 'C:\\stage', destinationRelativePath: 'raw' },
});
assert.strictEqual(command.type, 'file-operations.project-content.commit-import.v1');
assert.strictEqual(command.target, 'file-operations');
assert(Object.isFrozen(command) && Object.isFrozen(command.payload));
assert.strictEqual(assertProjectContentCommand(command).commandId, eventId);
assert.throws(() => createProjectContentCommand({ ...command, operation: 'overwrite-anything' }), /Unsupported/);

const bus = createEventBus();
const allEvents = [];
const typedEvents = [];
bus.on('domain-event', value => allEvents.push(value));
bus.on(event.type, value => typedEvents.push(value));
assert.strictEqual(bus.publish(event).eventId, eventId);
assert.deepStrictEqual(allEvents, [event]);
assert.deepStrictEqual(typedEvents, [event]);
assert.throws(() => bus.publish({ type: 'invalid' }), /unsupported domain event schema/);
bus.clear();

const root = path.resolve(__dirname, '..');
for (const relative of LEGACY_PROJECT_CONTENT_WRITERS) {
  assert(fs.existsSync(path.join(root, relative)), `legacy writer must exist or be removed from the migration list: ${relative}`);
}
assert.strictEqual(new Set(LEGACY_PROJECT_CONTENT_WRITERS).size, LEGACY_PROJECT_CONTENT_WRITERS.length, 'legacy writers must be unique');

const mutationCallPattern = /\b(?:copyFileAtomic|moveFileAtomic|movePathAtomic)\s*\(|recycleBinService\.(?:trash|restore)\s*\(/;
const mutationRoots = ['electron/modules', 'electron/services'];
const implementationFiles = new Set([
  'electron/services/file-system-service.cjs',
  'electron/services/file-transfer-service.cjs',
]);
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(absolute) : [absolute];
});
const directCallers = mutationRoots.flatMap(relative => walk(path.join(root, relative)))
  .filter(file => file.endsWith('.cjs') && mutationCallPattern.test(fs.readFileSync(file, 'utf8')))
  .map(file => path.relative(root, file).replaceAll('\\', '/'))
  .filter(file => !implementationFiles.has(file));
const unexpectedCallers = directCallers.filter(file => !LEGACY_PROJECT_CONTENT_WRITERS.includes(file));
assert.deepStrictEqual(unexpectedCallers, [], `new project-content mutation caller must use the file-operations command boundary: ${unexpectedCallers.join(', ')}`);

const documentation = fs.readFileSync(path.join(root, 'docs', 'DOMAIN_BOUNDARIES.md'), 'utf8');
assert(documentation.includes('Only `file-operations`') && documentation.includes('domain.entity.action.vN'));

console.log('Domain ownership and event contract tests passed.');
