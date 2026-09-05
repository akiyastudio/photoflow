export type WorkflowGenerationState = 'idle' | 'running' | 'awaiting-confirmation' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type WorkflowGenerationModel = {
  projectId: string; operationId: string; state: WorkflowGenerationState; phase: string;
  progress: number; message: string; completedFiles: number; totalFiles: number;
};

export const idleWorkflowGeneration = (projectId = ''): WorkflowGenerationModel => ({ projectId, operationId: '', state: 'idle', phase: 'idle', progress: 0, message: '', completedFiles: 0, totalFiles: 0 });

export const createWorkflowStatusController = (initialScope = '') => {
  let scope = initialScope; let generation = 0;
  return {
    setScope(nextScope: string) { if (nextScope !== scope) { scope = nextScope; generation += 1; } },
    begin() { return { scope, generation }; },
    invalidate() { generation += 1; },
    accepts(token: { scope: string; generation: number }, current: { operationId?: unknown }, job: { operationId?: unknown }) {
      const currentOperationId = String(current.operationId || ''); const jobOperationId = String(job.operationId || '');
      return token.scope === scope && token.generation === generation && Boolean(jobOperationId) && (!currentOperationId || currentOperationId === jobOperationId);
    },
  };
};

const stateOf = (value: Record<string, unknown>): WorkflowGenerationState => {
  if (value.requiresConfirmation || value.state === 'awaiting-confirmation' || value.phase === 'confirmation') return 'awaiting-confirmation';
  if (value.cancelled || value.state === 'cancelled') return 'cancelled';
  if (value.state === 'cancelling' || value.state === 'cancel-requested') return 'cancelling';
  if (value.success === false || value.state === 'failed') return 'failed';
  if (value.state === 'running' || value.state === 'accepted') return 'running';
  if (value.success === true && !value.alreadyRunning || value.state === 'completed') return 'completed';
  return 'running';
};

export const reduceWorkflowGeneration = (current: WorkflowGenerationModel, value: unknown, source: 'start' | 'event' | 'rpc' | 'status' | 'cancel' = 'event'): WorkflowGenerationModel => {
  if (!value || typeof value !== 'object') return current;
  const update = value as Record<string, unknown>;
  const projectId = String(update.projectId || current.projectId || '');
  const operationId = String(update.operationId || (update.operation as Record<string, unknown> | undefined)?.operationId || current.operationId || '');
  if (!projectId || !operationId) return current;
  if (current.projectId && current.projectId !== projectId) return current;
  if (source === 'event' && current.operationId && current.operationId !== operationId) return current;
  const operation = update.operation && typeof update.operation === 'object' ? update.operation as Record<string, unknown> : {};
  const merged = { ...update, ...operation };
  let state = source === 'start' ? 'running' : stateOf(merged);
  if (source === 'cancel' && state === 'running') state = 'cancelling';
  return {
    projectId, operationId, state,
    phase: String(merged.phase || state), progress: Number(merged.progress ?? current.progress) || 0,
    message: String(merged.message || merged.error || current.message || ''),
    completedFiles: Number(merged.completedFiles ?? current.completedFiles) || 0,
    totalFiles: Number(merged.totalFiles ?? current.totalFiles) || 0,
  };
};
