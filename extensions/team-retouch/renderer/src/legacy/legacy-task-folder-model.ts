type Json = Record<string, any>;

export const prepareAndOpenWorkflowTaskFolder = async ({
  open,
  drain,
  onPreparing = () => undefined,
  maxAttempts = 3,
}: {
  open: () => Promise<Json>;
  drain: (maxItems: number) => Promise<Json>;
  onPreparing?: (result: Json) => void;
  maxAttempts?: number;
}) => {
  let result = await open();
  let reconciliation: Json | undefined;
  let attempts = 0;
  if (result?.success !== false && result?.state === 'preparing') onPreparing(result);
  while (result?.success !== false && result?.state === 'preparing' && attempts < Math.max(1, maxAttempts)) {
    attempts += 1;
    const pendingCount = Math.max(1, Number(result.pendingCount) || 1);
    reconciliation = await drain(Math.min(50, Math.max(20, pendingCount)));
    if (reconciliation?.success === false) break;
    result = await open();
    if (result?.state === 'preparing' && Number(reconciliation?.recoveredCount) <= 0) break;
  }
  return { result, reconciliation, attempts, preparationAttempted: attempts > 0 };
};
