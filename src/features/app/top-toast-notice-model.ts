export const MAX_PERSISTENT_NOTICES = 4;

export interface TopToastNotice {
  id: number;
  message: string;
  persistent: boolean;
  count: number;
}

export const enqueueTopToastNotice = (current: TopToastNotice[], incoming: TopToastNotice) => {
  if (!incoming.persistent) return [...current, incoming];
  const existing = current.find(notice => notice.persistent && notice.message === incoming.message);
  const next = existing
    ? [...current.filter(notice => notice.id !== existing.id), { ...existing, count: existing.count + 1 }]
    : [...current, incoming];
  let overflow = next.filter(notice => notice.persistent).length - MAX_PERSISTENT_NOTICES;
  if (overflow <= 0) return next;
  return next.filter(notice => {
    if (!notice.persistent || overflow <= 0) return true;
    overflow -= 1;
    return false;
  });
};

export const removeTopToastNotice = (current: TopToastNotice[], id: number) => current.filter(notice => notice.id !== id);
