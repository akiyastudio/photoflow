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

console.log('Team workflow scheduling tests passed.');
