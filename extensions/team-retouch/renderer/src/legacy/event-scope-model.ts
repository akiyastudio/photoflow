export type EventScope = { projectId: string; operationId?: string };

export const matchesCurrentEvent = (value: unknown, scope: EventScope, requireOperation = false) => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (!scope.projectId || String(event.projectId || '') !== scope.projectId) return false;
  if (requireOperation || scope.operationId) return Boolean(scope.operationId) && String(event.operationId || '') === scope.operationId;
  return true;
};
