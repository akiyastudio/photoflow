type Work<T> = () => Promise<T>;
type QueueItem<T> = { key: string; priority: number; sequence: number; work: Work<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

const MAX_CONCURRENCY = 5;
const MAX_ENTRIES = 96;
const TTL_MS = 15_000;
let active = 0;
let sequence = 0;
const queue: QueueItem<unknown>[] = [];
const inFlight = new Map<string, Promise<unknown>>();
const cache = new Map<string, { expiresAt: number; value: unknown }>();

const trim = () => {
  const now = Date.now();
  for (const [key, item] of cache) if (item.expiresAt <= now) cache.delete(key);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
};

const pump = () => {
  while (active < MAX_CONCURRENCY && queue.length) {
    queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    const item = queue.shift()!;
    active += 1;
    void item.work().then(value => {
      cache.delete(item.key);
      cache.set(item.key, { expiresAt: Date.now() + TTL_MS, value });
      trim();
      item.resolve(value);
    }, item.reject).finally(() => {
      active -= 1;
      inFlight.delete(item.key);
      pump();
    });
  }
};

export const scheduleLegacyMedia = <T>(key: string, work: Work<T>, priority = 0): Promise<T> => {
  trim();
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached.value as T);
  }
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = new Promise<T>((resolve, reject) => {
    queue.push({ key, priority, sequence: sequence++, work, resolve: resolve as (value: unknown) => void, reject });
    pump();
  });
  inFlight.set(key, pending);
  return pending;
};

export const expireLegacyMedia = (keyPrefix = '') => {
  for (const key of cache.keys()) if (!keyPrefix || key.startsWith(keyPrefix)) cache.delete(key);
};
