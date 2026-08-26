import type { NoticeTone } from './sdk';

export type HistoryToastSnapshot = { message: string; tone: NoticeTone } | undefined;

export const historyToastTransition = ({ previous, currentMessage, currentTone, inFlight, recoveredMessage, dedupeKey }: {
  previous: HistoryToastSnapshot;
  currentMessage: string;
  currentTone: NoticeTone;
  inFlight: boolean;
  recoveredMessage: string;
  dedupeKey: string;
}): { next: HistoryToastSnapshot; notice?: { message: string; tone: NoticeTone; dedupeKey: string } } => {
  const message = String(currentMessage || '').trim();
  if (message) {
    const next = { message, tone: currentTone };
    return previous?.message === message && previous.tone === currentTone
      ? { next: previous }
      : { next, notice: { ...next, dedupeKey } };
  }
  if (inFlight) return { next: previous };
  if (previous?.tone === 'warning' || previous?.tone === 'error') {
    return { next: undefined, notice: { message: recoveredMessage, tone: 'success', dedupeKey } };
  }
  return { next: undefined };
};
