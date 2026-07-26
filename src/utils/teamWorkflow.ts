export type WorkflowScheduleEntry = {
  key: string;
  taskId: string;
  personIndex: number;
  identityId?: string;
  identityName?: string;
};

export type WorkflowScheduleOptions = {
  preferredIdentityOrder?: string[];
  preferredIdentityId?: string;
};

type RankedEntry = WorkflowScheduleEntry & {
  scheduleIdentityId: string;
  rank: number;
  count: number;
};

const compareNumbers = (left: number[], right: number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
};

// Hungarian assignment for a rectangular cost matrix. Rows are task members
// and columns are the fixed set of project weeks.
const minimumCostAssignment = (costs: number[][]) => {
  const rowCount = costs.length;
  const columnCount = costs[0]?.length || 0;
  if (!rowCount || !columnCount) return [];
  const rowPotential = Array(rowCount + 1).fill(0) as number[];
  const columnPotential = Array(columnCount + 1).fill(0) as number[];
  const matchedRow = Array(columnCount + 1).fill(0) as number[];
  const previousColumn = Array(columnCount + 1).fill(0) as number[];

  for (let row = 1; row <= rowCount; row += 1) {
    matchedRow[0] = row;
    let column = 0;
    const minimum = Array(columnCount + 1).fill(Number.POSITIVE_INFINITY) as number[];
    const used = Array(columnCount + 1).fill(false) as boolean[];
    do {
      used[column] = true;
      const currentRow = matchedRow[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= columnCount; candidate += 1) {
        if (used[candidate]) continue;
        const cost = costs[currentRow - 1][candidate - 1] - rowPotential[currentRow] - columnPotential[candidate];
        if (cost < minimum[candidate]) {
          minimum[candidate] = cost;
          previousColumn[candidate] = column;
        }
        if (minimum[candidate] < delta || (minimum[candidate] === delta && candidate < nextColumn)) {
          delta = minimum[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= columnCount; candidate += 1) {
        if (used[candidate]) {
          rowPotential[matchedRow[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else {
          minimum[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (matchedRow[column] !== 0);
    do {
      const previous = previousColumn[column];
      matchedRow[column] = matchedRow[previous];
      column = previous;
    } while (column !== 0);
  }

  const assignment = Array(rowCount).fill(-1) as number[];
  for (let column = 1; column <= columnCount; column += 1) {
    if (matchedRow[column]) assignment[matchedRow[column] - 1] = column - 1;
  }
  return assignment;
};

const scheduleScore = (entries: RankedEntry[], weeks: Map<string, number>, preferredIdentityOrder: string[] = []) => {
  const identityWeeks = new Map<string, Set<number>>();
  const preferenceRank = new Map(preferredIdentityOrder.map((identityId, index) => [identityId, index]));
  let preferenceViolations = 0;
  let priorityWeekCost = 0;
  for (const entry of entries) {
    const week = weeks.get(entry.key) || 1;
    if (preferredIdentityOrder[0] && entry.identityId === preferredIdentityOrder[0] && week !== 1) preferenceViolations += 1;
    if (entry.identityId) {
      const used = identityWeeks.get(entry.identityId) || new Set<number>();
      used.add(week);
      identityWeeks.set(entry.identityId, used);
      priorityWeekCost += week * Math.max(1, entries.length - entry.rank);
    }
  }
  const entriesByTask = new Map<string, RankedEntry[]>();
  for (const entry of entries) {
    const members = entriesByTask.get(entry.taskId) || [];
    members.push(entry);
    entriesByTask.set(entry.taskId, members);
  }
  for (const members of entriesByTask.values()) {
    const preferredMembers = members
      .filter(member => member.identityId && preferenceRank.has(member.identityId))
      .sort((left, right) => preferenceRank.get(left.identityId!)! - preferenceRank.get(right.identityId!)!);
    for (let index = 1; index < preferredMembers.length; index += 1) {
      if ((weeks.get(preferredMembers[index - 1].key) || 1) >= (weeks.get(preferredMembers[index].key) || 1)) preferenceViolations += 1;
    }
  }
  let fragmentation = 0;
  let span = 0;
  for (const used of identityWeeks.values()) {
    fragmentation += Math.max(0, used.size - 1);
    if (used.size > 1) span += Math.max(...used) - Math.min(...used);
  }
  return [preferenceViolations, fragmentation, span, priorityWeekCost];
};

export const scheduleWorkflowWeeks = (sourceEntries: WorkflowScheduleEntry[], options: WorkflowScheduleOptions = {}) => {
  const result = new Map<string, number>();
  if (!sourceEntries.length) return result;
  const identityCounts = new Map<string, number>();
  const identityNames = new Map<string, string>();
  for (const entry of sourceEntries) {
    if (!entry.identityId) continue;
    identityCounts.set(entry.identityId, (identityCounts.get(entry.identityId) || 0) + 1);
    identityNames.set(entry.identityId, entry.identityName || entry.identityId);
  }
  const requestedPreferredIdentityOrder = Array.isArray(options.preferredIdentityOrder) && options.preferredIdentityOrder.length
    ? options.preferredIdentityOrder
    : options.preferredIdentityId ? [options.preferredIdentityId] : [];
  const preferredIdentityOrder = [...new Set(requestedPreferredIdentityOrder.map(String))].filter(identityId => identityCounts.has(identityId));
  const preferredIdentityId = preferredIdentityOrder[0] || '';
  const preferenceRank = new Map(preferredIdentityOrder.map((identityId, index) => [identityId, index]));
  const identityIds = [...identityCounts.keys()].sort((left, right) =>
    (preferenceRank.get(left) ?? Number.MAX_SAFE_INTEGER) - (preferenceRank.get(right) ?? Number.MAX_SAFE_INTEGER)
    || (identityCounts.get(right) || 0) - (identityCounts.get(left) || 0)
    || (identityNames.get(left) || left).localeCompare(identityNames.get(right) || right)
    || left.localeCompare(right));
  const identityRank = new Map(identityIds.map((identityId, index) => [identityId, index]));
  const entries: RankedEntry[] = sourceEntries.map((entry, index) => ({
    ...entry,
    scheduleIdentityId: entry.identityId || `__unassigned__:${entry.key}`,
    rank: entry.identityId ? identityRank.get(entry.identityId) ?? identityIds.length : identityIds.length + index,
    count: entry.identityId ? identityCounts.get(entry.identityId) || 1 : 1,
  }));

  const byTask = new Map<string, RankedEntry[]>();
  for (const entry of entries) {
    const members = byTask.get(entry.taskId) || [];
    members.push(entry);
    byTask.set(entry.taskId, members);
  }
  const tasks = [...byTask.entries()].map(([taskId, members]) => ({
    taskId,
    members: [...members].sort((left, right) => left.rank - right.rank || left.personIndex - right.personIndex || left.key.localeCompare(right.key)),
  })).sort((left, right) => right.members.length - left.members.length || left.taskId.localeCompare(right.taskId));
  const weekCount = Math.max(1, ...tasks.map(task => task.members.length));

  // Build a deterministic preferred week for each identity. Sharing a task
  // increases conflict weight; high-coverage identities choose first.
  const conflicts = new Map<string, Map<string, number>>();
  for (const task of tasks) {
    const uniqueIds = [...new Set(task.members.map(member => member.scheduleIdentityId))];
    for (let leftIndex = 0; leftIndex < uniqueIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < uniqueIds.length; rightIndex += 1) {
        const left = uniqueIds[leftIndex];
        const right = uniqueIds[rightIndex];
        const leftConflicts = conflicts.get(left) || new Map<string, number>();
        const rightConflicts = conflicts.get(right) || new Map<string, number>();
        leftConflicts.set(right, (leftConflicts.get(right) || 0) + 1);
        rightConflicts.set(left, (rightConflicts.get(left) || 0) + 1);
        conflicts.set(left, leftConflicts);
        conflicts.set(right, rightConflicts);
      }
    }
  }
  const orderedScheduleIds = [...new Set(entries.map(entry => entry.scheduleIdentityId))].sort((left, right) => {
    const leftEntry = entries.find(entry => entry.scheduleIdentityId === left)!;
    const rightEntry = entries.find(entry => entry.scheduleIdentityId === right)!;
    return leftEntry.rank - rightEntry.rank || rightEntry.count - leftEntry.count || left.localeCompare(right);
  });
  const preferredWeek = new Map<string, number>();
  const preferredLoad = Array(weekCount).fill(0) as number[];
  for (const identityId of orderedScheduleIds) {
    if (identityId === preferredIdentityId) {
      preferredWeek.set(identityId, 1);
      preferredLoad[0] += 1;
      continue;
    }
    let bestWeek = 1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let week = 1; week <= weekCount; week += 1) {
      let conflictCost = 0;
      for (const [otherId, weight] of conflicts.get(identityId) || []) {
        if (preferredWeek.get(otherId) === week) conflictCost += weight;
      }
      const cost = conflictCost * 1_000_000 + preferredLoad[week - 1] * 100 + week;
      if (cost < bestCost) {
        bestCost = cost;
        bestWeek = week;
      }
    }
    preferredWeek.set(identityId, bestWeek);
    preferredLoad[bestWeek - 1] += 1;
  }

  const weekUsage = new Map<string, number[]>();
  const assignTask = (members: RankedEntry[]) => {
    const costs = members.map(member => {
      const usage = weekUsage.get(member.scheduleIdentityId) || Array(weekCount).fill(0) as number[];
      const hasOtherUsage = usage.some(count => count > 0);
      return Array.from({ length: weekCount }, (_, weekIndex) => {
        const week = weekIndex + 1;
        const addsActivation = hasOtherUsage && usage[weekIndex] === 0;
        const activeWeeks = usage.map((count, index) => count > 0 ? index + 1 : 0).filter(Boolean);
        const nextMinimum = activeWeeks.length ? Math.min(...activeWeeks, week) : week;
        const nextMaximum = activeWeeks.length ? Math.max(...activeWeeks, week) : week;
        const currentSpan = activeWeeks.length ? Math.max(...activeWeeks) - Math.min(...activeWeeks) : 0;
        const spanGrowth = nextMaximum - nextMinimum - currentSpan;
        const offPreferred = preferredWeek.get(member.scheduleIdentityId) === week ? 0 : 1;
        const priorityStrength = Math.max(1, entries.length - member.rank);
        return (addsActivation ? 1_000_000 : 0) + spanGrowth * 10_000 + offPreferred * priorityStrength * 10 + week;
      });
    });
    const assignedWeeks = minimumCostAssignment(costs).map(column => column + 1);
    const preferredMemberIndexes = members
      .map((member, index) => ({ index, rank: member.identityId ? preferenceRank.get(member.identityId) : undefined }))
      .filter((item): item is { index: number; rank: number } => item.rank !== undefined)
      .sort((left, right) => left.rank - right.rank);
    if (preferredMemberIndexes.length > 1) {
      const orderedWeeks = preferredMemberIndexes.map(item => assignedWeeks[item.index]).sort((left, right) => left - right);
      preferredMemberIndexes.forEach((item, index) => { assignedWeeks[item.index] = orderedWeeks[index]; });
    }
    const firstPreferredIndex = members.findIndex(member => member.identityId === preferredIdentityId);
    if (firstPreferredIndex >= 0 && assignedWeeks[firstPreferredIndex] !== 1) {
      const weekOneIndex = assignedWeeks.indexOf(1);
      if (weekOneIndex >= 0) [assignedWeeks[firstPreferredIndex], assignedWeeks[weekOneIndex]] = [assignedWeeks[weekOneIndex], assignedWeeks[firstPreferredIndex]];
      else assignedWeeks[firstPreferredIndex] = 1;
    }
    if (preferredMemberIndexes.length > 1) {
      const orderedWeeks = preferredMemberIndexes.map(item => assignedWeeks[item.index]).sort((left, right) => left - right);
      preferredMemberIndexes.forEach((item, index) => { assignedWeeks[item.index] = orderedWeeks[index]; });
    }
    return assignedWeeks;
  };

  for (const task of tasks) {
    const assignedWeeks = assignTask(task.members);
    task.members.forEach((member, index) => {
      const week = assignedWeeks[index];
      result.set(member.key, week);
      const usage = weekUsage.get(member.scheduleIdentityId) || Array(weekCount).fill(0) as number[];
      usage[week - 1] += 1;
      weekUsage.set(member.scheduleIdentityId, usage);
    });
  }

  // Coordinate-descent passes can remove fragmentation introduced by task
  // processing order. A candidate is accepted only when the global objective
  // improves, so the loop is deterministic and cannot oscillate.
  let currentScore = scheduleScore(entries, result, preferredIdentityOrder);
  for (let pass = 0; pass < 6; pass += 1) {
    let improved = false;
    for (const task of tasks) {
      for (const member of task.members) {
        const oldWeek = result.get(member.key)!;
        weekUsage.get(member.scheduleIdentityId)![oldWeek - 1] -= 1;
      }
      const candidateWeeks = assignTask(task.members);
      const previousWeeks = task.members.map(member => result.get(member.key)!);
      task.members.forEach((member, index) => result.set(member.key, candidateWeeks[index]));
      const candidateScore = scheduleScore(entries, result, preferredIdentityOrder);
      if (compareNumbers(candidateScore, currentScore) < 0) {
        currentScore = candidateScore;
        improved = true;
      } else {
        task.members.forEach((member, index) => result.set(member.key, previousWeeks[index]));
      }
      for (const member of task.members) {
        const week = result.get(member.key)!;
        weekUsage.get(member.scheduleIdentityId)![week - 1] += 1;
      }
    }
    if (!improved) break;
  }
  return result;
};
