export type DialogQueueEntry<TRequest, TResult> = { token: number; request: TRequest; resolve: (value: TResult) => void };

export const createDialogQueue = <TRequest, TResult>() => {
  let nextToken = 1;
  const entries: DialogQueueEntry<TRequest, TResult>[] = [];
  const settled = new Set<number>();
  return {
    ask(request: TRequest) { return new Promise<TResult>(resolve => { entries.push({ token: nextToken++, request, resolve }); }); },
    current: () => entries[0],
    settle(token: number, value: TResult) {
      const current = entries[0];
      if (!current || current.token !== token || settled.has(token)) return false;
      settled.add(token); entries.shift(); current.resolve(value); return true;
    },
    size: () => entries.length,
  };
};
