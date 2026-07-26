import assert from 'node:assert/strict';
import { scheduleWorkflowWeeks } from '../src/utils/teamWorkflow.ts';

const entry = (taskId, identityId, personIndex) => ({
  key: `${taskId}:${identityId}`,
  taskId,
  personIndex,
  identityId,
  identityName: identityId,
});

const identityWeekCounts = (entries, schedule) => {
  const result = new Map();
  for (const item of entries) {
    const weeks = result.get(item.identityId) || new Set();
    weeks.add(schedule.get(item.key));
    result.set(item.identityId, weeks);
  }
  return result;
};

const assertTaskWeeksAreUnique = (entries, schedule) => {
  const tasks = new Map();
  for (const item of entries) {
    const weeks = tasks.get(item.taskId) || [];
    weeks.push(schedule.get(item.key));
    tasks.set(item.taskId, weeks);
  }
  for (const weeks of tasks.values()) assert.equal(new Set(weeks).size, weeks.length);
};

const assertPreferredOrder = (entries, schedule, preferredIdentityOrder) => {
  const preferenceRank = new Map(preferredIdentityOrder.map((identityId, index) => [identityId, index]));
  const tasks = new Map();
  for (const item of entries) {
    const members = tasks.get(item.taskId) || [];
    members.push(item);
    tasks.set(item.taskId, members);
  }
  for (const members of tasks.values()) {
    const preferredMembers = members.filter(item => preferenceRank.has(item.identityId)).sort((left, right) => preferenceRank.get(left.identityId) - preferenceRank.get(right.identityId));
    for (let index = 1; index < preferredMembers.length; index += 1) {
      assert.ok(schedule.get(preferredMembers[index - 1].key) < schedule.get(preferredMembers[index].key));
    }
  }
};

// This chain is two-colourable. Every person can therefore receive all of
// their work in one week without increasing the two-week project duration.
const chain = [
  entry('A', '1', 1), entry('A', '2', 2),
  entry('B', '2', 1), entry('B', '3', 2),
  entry('C', '3', 1), entry('C', '4', 2),
];
const chainSchedule = scheduleWorkflowWeeks(chain);
assertTaskWeeksAreUnique(chain, chainSchedule);
assert.equal(Math.max(...chainSchedule.values()), 2);
for (const weeks of identityWeekCounts(chain, chainSchedule).values()) assert.equal(weeks.size, 1);

// An odd conflict cycle cannot put every person in a single week while still
// finishing in two weeks. The optimum is exactly one fragmented identity.
const triangle = [
  entry('A', '1', 1), entry('A', '2', 2),
  entry('B', '2', 1), entry('B', '3', 2),
  entry('C', '1', 1), entry('C', '3', 2),
];
const triangleSchedule = scheduleWorkflowWeeks(triangle);
assertTaskWeeksAreUnique(triangle, triangleSchedule);
assert.equal(Math.max(...triangleSchedule.values()), 2);
assert.equal([...identityWeekCounts(triangle, triangleSchedule).values()].filter(weeks => weeks.size > 1).length, 1);

// Equal inputs must never jump between equivalent schedules.
assert.deepEqual([...scheduleWorkflowWeeks(triangle)], [...triangleSchedule]);

// A manually selected starter is a hard constraint: every occurrence of that
// identity starts in week one while unrelated tasks can still run in parallel.
const preferredSchedule = scheduleWorkflowWeeks(triangle, { preferredIdentityId: '3' });
assertTaskWeeksAreUnique(triangle, preferredSchedule);
for (const item of triangle.filter(candidate => candidate.identityId === '3')) {
  assert.equal(preferredSchedule.get(item.key), 1);
}

// A stale preference must behave like automatic scheduling instead of
// producing an invalid or partially constrained result.
assert.deepEqual([...scheduleWorkflowWeeks(triangle, { preferredIdentityId: 'missing' })], [...triangleSchedule]);

// Multiple manually ordered identities keep their relative order whenever
// they share a task. The first queued identity remains the absolute starter.
const orderedSchedule = scheduleWorkflowWeeks(triangle, { preferredIdentityOrder: ['1', '2', '3'] });
assertTaskWeeksAreUnique(triangle, orderedSchedule);
assertPreferredOrder(triangle, orderedSchedule, ['1', '2', '3']);
for (const item of triangle.filter(candidate => candidate.identityId === '1')) assert.equal(orderedSchedule.get(item.key), 1);

// Dragging the same people into the reverse order must reverse every shared
// task relation instead of merely reordering cards in the interface.
const reversedSchedule = scheduleWorkflowWeeks(triangle, { preferredIdentityOrder: ['3', '2', '1'] });
assertTaskWeeksAreUnique(triangle, reversedSchedule);
assertPreferredOrder(triangle, reversedSchedule, ['3', '2', '1']);
for (const item of triangle.filter(candidate => candidate.identityId === '3')) assert.equal(reversedSchedule.get(item.key), 1);

// The preferred starter must still use week one in a smaller task even when
// another task makes additional global week columns available.
const uneven = [
  entry('wide', '1', 1), entry('wide', '2', 2), entry('wide', '3', 3),
  entry('small', '4', 1), entry('small', '5', 2),
];
const unevenSchedule = scheduleWorkflowWeeks(uneven, { preferredIdentityOrder: ['4', '5'] });
assertTaskWeeksAreUnique(uneven, unevenSchedule);
assertPreferredOrder(uneven, unevenSchedule, ['4', '5']);
assert.equal(unevenSchedule.get('small:4'), 1);

console.log('Team workflow scheduling tests passed.');
