export type SequentialBatchResult<T> = { total: number; succeeded: T[]; failed: Array<{ item: T; error: Error }>; tone: 'success' | 'warning' | 'error' };

export const runSequentialMergeBatch = async <T, R extends { success?: boolean; error?: unknown }>(items: T[], run: (item: T, index: number) => Promise<R>, onSettled: (result: { item: T; index: number; success: boolean; error?: Error }) => void = () => undefined): Promise<SequentialBatchResult<T>> => {
  const succeeded: T[] = []; const failed: Array<{ item: T; error: Error }> = [];
  for (const [index, item] of items.entries()) {
    try {
      const result = await run(item, index);
      if (result?.success === false) throw normalizeFailure(result.error);
      succeeded.push(item); onSettled({ item, index, success: true });
    } catch (value) {
      const error = normalizeFailure(value); failed.push({ item, error }); onSettled({ item, index, success: false, error });
    }
  }
  return { total: items.length, succeeded, failed, tone: failed.length === 0 ? 'success' : succeeded.length ? 'warning' : 'error' };
};

const normalizeFailure = (value: unknown) => value instanceof Error ? value : new Error(String(value || '未知错误'));
