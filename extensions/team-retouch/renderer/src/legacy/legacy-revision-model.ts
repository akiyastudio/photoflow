type Json = Record<string, any>;

// Keep this list aligned with the service's guarded mutation surface. A single
// renderer can issue requests from both the shell and the workflow dialogs, so
// they must share one revision queue instead of racing through separate callers.
export const TEAM_REVISION_MUTATIONS = new Set([
  'team.project.migrate-step.v1', 'team.project.calibrate-step.v1', 'team.workflow.reconcile-drain.v1',
  'team.project.register.v1', 'team.project.remove-photo.v1', 'team.identity.save.v1', 'team.identity.assign.v1', 'team.identity.confirm-group.v1', 'team.identity.delete.v1', 'team.identity.suggest.v1',
  'team.person.exclude.v1', 'team.patch.detect.v1', 'team.patch.detect-batch.v1', 'team.patch.update.v1', 'team.patch.delete.v1', 'team.patch.cleanup.v1', 'team.patch.upload.v1', 'team.patch.remove-upload.v1', 'team.patch.merge.v1',
  'team.identity.complete.v1', 'team.workflow.settings.save.v1', 'team.workflow.generate.v1', 'team.workflow.open-export.v1', 'team.workflow.return-batch.v1', 'team.workflow.return-confirm.v1', 'team.patch.return-batch.v1', 'team.operation.run.v1',
  'team.workflow.return-review.discard.v1', 'team.workflow.return-review.ignore.v1',
]);

const validRevision = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
};

export const isTeamRevisionConflict = (error: unknown) => /(?:团片|图片)数据已被其他操作更新|TEAM_REVISION_CONFLICT|COMPONENT_HOST_CONFLICT/i.test(error instanceof Error ? error.message : String(error || ''));

export const retryOnceAfterRevisionConflict = async <T>(action: () => Promise<T>, refresh: () => Promise<unknown>) => {
  try { return await action(); }
  catch (error) {
    if (!isTeamRevisionConflict(error)) throw error;
    await refresh();
    return action();
  }
};

export const createTeamRevisionCoordinator = () => {
  let activeScope = '';
  const revisions = new Map<string, number>();
  const mutationTails = new Map<string, Promise<void>>();
  const normalizeScope = (scope = activeScope) => String(scope || '__default__');
  const observe = (value: Json | undefined, scope = activeScope) => {
    const revision = validRevision(value?.revision);
    if (revision === undefined) return;
    const key = normalizeScope(scope);
    const current = revisions.get(key);
    if (current === undefined || revision > current) revisions.set(key, revision);
  };
  const request = (method: string, value: Json | undefined, scope: string) => {
    const revision = revisions.get(normalizeScope(scope));
    if (!TEAM_REVISION_MUTATIONS.has(method) || revision === undefined || (value?.expectedRevision !== undefined && value.expectedRevision !== '')) return value;
    return { ...(value || {}), expectedRevision: String(revision) };
  };
  const run = <T extends Json>(method: string, value: Json | undefined, invoke: (request: Json | undefined) => Promise<T>) => {
    const scope = normalizeScope();
    const execute = async () => {
      if (TEAM_REVISION_MUTATIONS.has(method) && normalizeScope() !== scope) throw new Error('项目已切换，已取消旧项目的待执行操作');
      const result = await invoke(request(method, value, scope));
      observe(result, scope);
      return result;
    };
    if (!TEAM_REVISION_MUTATIONS.has(method)) return execute();
    const previous = mutationTails.get(scope) || Promise.resolve();
    const operation = previous.then(execute, execute);
    const tail = operation.then(() => undefined, () => undefined);
    mutationTails.set(scope, tail);
    void tail.then(() => { if (mutationTails.get(scope) === tail) mutationTails.delete(scope); });
    return operation;
  };
  return {
    setScope: (scope: string) => { activeScope = String(scope || ''); },
    getScope: () => activeScope,
    observe,
    run,
    revision: (scope = activeScope) => revisions.get(normalizeScope(scope)),
  };
};
